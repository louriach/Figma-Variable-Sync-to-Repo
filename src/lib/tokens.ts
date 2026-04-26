/**
 * Converts between Figma raw variable data and W3C DTCG token files.
 *
 * File layout (one JSON file per Figma variable collection):
 *   Single-mode collection → flat W3C token tree
 *   Multi-mode collection  → $metadata wrapper + one key per mode name
 *
 * Variable names use "/" as group separator (e.g. "color/brand/primary")
 * which maps to nested token groups in the JSON.
 *
 * Aliases are stored as W3C references: { $value: "{color.brand.primary}" }
 */

import type {
  TokenFile,
  TokenType,
  DesignToken,
  TokenGroup,
  RawCollection,
  RawVariable,
  ScalarValue,
  RawVariableValue,
  FileDiff,
} from '../types';

// ─── Figma → Tokens ──────────────────────────────────────────────────────────

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return a < 1 ? `#${h(r)}${h(g)}${h(b)}${h(a)}` : `#${h(r)}${h(g)}${h(b)}`;
}

function figmaTypeToTokenType(resolvedType: string): TokenType {
  if (resolvedType === 'COLOR') return 'color';
  if (resolvedType === 'FLOAT') return 'number';
  if (resolvedType === 'BOOLEAN') return 'boolean';
  return 'string';
}

function scalarToTokenValue(
  resolvedType: string,
  value: ScalarValue
): string | number | boolean {
  if (resolvedType === 'COLOR' && typeof value === 'object' && 'r' in value) {
    return rgbaToHex(value.r, value.g, value.b, value.a ?? 1);
  }
  return value as string | number | boolean;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(k: string): boolean {
  return !DANGEROUS_KEYS.has(k);
}

function setNested(obj: TokenGroup, path: string[], token: DesignToken): void {
  if (path.some((k) => !isSafeKey(k))) return;
  let cur: TokenGroup = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!cur[key] || '$value' in (cur[key] as object)) cur[key] = Object.create(null);
    cur = cur[key] as TokenGroup;
  }
  cur[path[path.length - 1]] = token;
}

function buildTokenGroup(
  variables: RawVariable[],
  modeId: string,
  aliasResolver: (id: string) => string | null
): TokenGroup {
  const group: TokenGroup = {};
  for (const v of variables) {
    const rawVal = v.valuesByMode[modeId];
    if (rawVal === undefined) continue;

    let tokenValue: string | number | boolean;
    if (
      rawVal &&
      typeof rawVal === 'object' &&
      'type' in rawVal &&
      (rawVal as RawVariableValue).type === 'alias'
    ) {
      const ref = aliasResolver((rawVal as RawVariableValue).id);
      if (!ref) continue;
      tokenValue = `{${ref.replace(/\//g, '.')}}`;
    } else {
      tokenValue = scalarToTokenValue(v.resolvedType, rawVal as ScalarValue);
    }

    const token: DesignToken = {
      $value: tokenValue,
      $type: figmaTypeToTokenType(v.resolvedType),
    };
    if (v.description) token.$description = v.description;

    setNested(group, v.name.split('/'), token);
  }
  return group;
}

export function collectionsToTokenFiles(
  collections: RawCollection[]
): Record<string, { fileName: string; content: TokenFile }> {
  // Build a global ID → name map for alias resolution
  const idToName = new Map<string, string>();
  for (const col of collections) {
    for (const v of col.variables) idToName.set(v.id, v.name);
  }
  const resolver = (id: string) => idToName.get(id) ?? null;

  const result: Record<string, { fileName: string; content: TokenFile }> = {};

  for (const col of collections) {
    const isSingle = col.modes.length === 1;
    const fileName = col.name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.json';

    let content: TokenFile;

    if (isSingle) {
      const modeId = col.modes[0].modeId;
      content = buildTokenGroup(col.variables, modeId, resolver) as TokenFile;
    } else {
      content = {
        $metadata: {
          collection: col.name,
          modes: col.modes.map((m) => m.name),
        },
      };
      for (const mode of col.modes) {
        content[mode.name] = buildTokenGroup(col.variables, mode.modeId, resolver);
      }
    }

    result[col.id] = { fileName, content };
  }

  return result;
}

// ─── Tokens → Figma ──────────────────────────────────────────────────────────

function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const c = hex.replace('#', '');
  const len = c.length;
  if (len === 3 || len === 4) {
    const [r, g, b, a] = c.split('').map((x) => parseInt(x + x, 16) / 255);
    return { r, g, b, a: len === 4 ? a : 1 };
  }
  return {
    r: parseInt(c.slice(0, 2), 16) / 255,
    g: parseInt(c.slice(2, 4), 16) / 255,
    b: parseInt(c.slice(4, 6), 16) / 255,
    a: len === 8 ? parseInt(c.slice(6, 8), 16) / 255 : 1,
  };
}

interface FlatToken {
  path: string[];
  token: DesignToken;
}

const MAX_TOKEN_DEPTH = 20;

function flattenGroup(obj: TokenGroup, prefix: string[] = [], depth = 0): FlatToken[] {
  if (depth > MAX_TOKEN_DEPTH) return [];
  const out: FlatToken[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('$') || !isSafeKey(key)) continue;
    const path = [...prefix, key];
    if (val && typeof val === 'object' && '$value' in val) {
      out.push({ path, token: val as DesignToken });
    } else {
      out.push(...flattenGroup(val as TokenGroup, path, depth + 1));
    }
  }
  return out;
}

export function tokenFilesToCollections(
  files: Record<string, TokenFile>
): RawCollection[] {
  // Two-pass: first collect all variable names, then resolve aliases
  const collections: RawCollection[] = [];

  // Collect all variable names for alias resolution in pass 2
  const nameToId = new Map<string, string>();
  let idCounter = 0;
  const nextId = () => `imported-${idCounter++}`;

  // Pass 1: build structure, assign placeholder IDs
  for (const [fileName, file] of Object.entries(files)) {
    const metadata = file.$metadata as { collection?: string; modes?: string[] } | undefined;
    const baseName = fileName.replace(/\.json$/i, '');
    const defaultName = baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/[-_]/g, ' ');
    const colName: string = metadata?.collection ?? defaultName;
    const modes: string[] = metadata?.modes ?? [];

    const isSingle = modes.length <= 1;

    const rawModes: Array<{ modeId: string; name: string }> = [];
    const variableMap = new Map<string, RawVariable>();

    if (isSingle) {
      const modeName = modes[0] ?? 'Mode 1';
      const modeId = `mode-0`;
      rawModes.push({ modeId, name: modeName });

      const flat = flattenGroup(file as unknown as TokenGroup);
      for (const { path, token } of flat) {
        const varName = path.join('/');
        const id = nextId();
        nameToId.set(varName, id);
        variableMap.set(varName, {
          id,
          name: varName,
          resolvedType: tokenTypeToFigma(token.$type),
          description: token.$description ?? '',
          valuesByMode: { [modeId]: resolveRawValue(token, varName) },
        });
      }
    } else {
      modes.forEach((modeName, i) => rawModes.push({ modeId: `mode-${i}`, name: modeName }));

      for (let i = 0; i < modes.length; i++) {
        const modeId = `mode-${i}`;
        const modeName = modes[i];
        const modeGroup = file[modeName] as TokenGroup | undefined;
        if (!modeGroup) continue;

        const flat = flattenGroup(modeGroup);
        for (const { path, token } of flat) {
          const varName = path.join('/');
          if (!variableMap.has(varName)) {
            const id = nextId();
            nameToId.set(varName, id);
            variableMap.set(varName, {
              id,
              name: varName,
              resolvedType: tokenTypeToFigma(token.$type),
              description: token.$description ?? '',
              valuesByMode: {},
            });
          }
          const v = variableMap.get(varName)!;
          v.valuesByMode[modeId] = resolveRawValue(token, varName);
        }
      }
    }

    collections.push({
      id: `col-${colName}`,
      name: colName,
      modes: rawModes,
      variables: Array.from(variableMap.values()),
    });
  }

  // Pass 2: resolve W3C references {a.b.c} → alias objects
  for (const col of collections) {
    for (const v of col.variables) {
      for (const [modeId, val] of Object.entries(v.valuesByMode)) {
        if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
          const refPath = val.slice(1, -1).replace(/\./g, '/');
          const refId = nameToId.get(refPath);
          if (refId) {
            v.valuesByMode[modeId] = { type: 'alias', id: refId } as RawVariableValue;
          }
        }
      }
    }
  }

  return collections;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function flattenToValueMap(file: TokenFile): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  const metadata = file.$metadata as { modes?: string[] } | undefined;
  const modes = metadata?.modes ?? [];

  if (modes.length > 1) {
    for (const mode of modes) {
      const group = (file as Record<string, unknown>)[mode] as TokenGroup | undefined;
      if (!group) continue;
      for (const { path, token } of flattenGroup(group)) {
        map.set(`${mode}::${path.join('/')}`, token.$value as string | number | boolean);
      }
    }
  } else {
    for (const { path, token } of flattenGroup(file as unknown as TokenGroup)) {
      map.set(path.join('/'), token.$value as string | number | boolean);
    }
  }
  return map;
}

export function diffTokenFiles(
  remoteFiles: Record<string, TokenFile>,
  localFiles: Record<string, TokenFile>
): FileDiff[] {
  return Object.entries(remoteFiles).map(([fileName, remoteFile]) => {
    const localFile = localFiles[fileName];
    const remote = flattenToValueMap(remoteFile);
    const local = localFile ? flattenToValueMap(localFile) : new Map<string, string | number | boolean>();

    let added = 0, updated = 0, removed = 0;

    for (const [path, value] of remote) {
      if (!local.has(path)) added++;
      else if (JSON.stringify(local.get(path)) !== JSON.stringify(value)) updated++;
    }
    for (const path of local.keys()) {
      if (!remote.has(path)) removed++;
    }

    return { fileName, added, updated, removed, hasChanges: added + updated + removed > 0 };
  });
}

function tokenTypeToFigma(type: TokenType): 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' {
  if (type === 'color') return 'COLOR';
  if (type === 'number' || type === 'dimension') return 'FLOAT';
  if (type === 'boolean') return 'BOOLEAN';
  return 'STRING';
}

function resolveRawValue(
  token: DesignToken,
  _varName: string
): ScalarValue | string {
  const v = token.$value;
  // References are handled in pass 2
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) return v;
  if (token.$type === 'color' && typeof v === 'string') return hexToRgba(v);
  return v as ScalarValue;
}


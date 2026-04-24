"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectionsToTokenFiles = collectionsToTokenFiles;
exports.tokenFilesToCollections = tokenFilesToCollections;
exports.diffTokenFiles = diffTokenFiles;
// ─── Figma → Tokens ──────────────────────────────────────────────────────────
function rgbaToHex(r, g, b, a) {
    const h = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
    return a < 1 ? `#${h(r)}${h(g)}${h(b)}${h(a)}` : `#${h(r)}${h(g)}${h(b)}`;
}
function figmaTypeToTokenType(resolvedType) {
    if (resolvedType === 'COLOR')
        return 'color';
    if (resolvedType === 'FLOAT')
        return 'number';
    if (resolvedType === 'BOOLEAN')
        return 'boolean';
    return 'string';
}
function scalarToTokenValue(resolvedType, value) {
    var _a;
    if (resolvedType === 'COLOR' && typeof value === 'object' && 'r' in value) {
        return rgbaToHex(value.r, value.g, value.b, (_a = value.a) !== null && _a !== void 0 ? _a : 1);
    }
    return value;
}
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(k) {
    return !DANGEROUS_KEYS.has(k);
}
function setNested(obj, path, token) {
    if (path.some((k) => !isSafeKey(k)))
        return;
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (!cur[key] || '$value' in cur[key])
            cur[key] = Object.create(null);
        cur = cur[key];
    }
    cur[path[path.length - 1]] = token;
}
function buildTokenGroup(variables, modeId, aliasResolver) {
    const group = {};
    for (const v of variables) {
        const rawVal = v.valuesByMode[modeId];
        if (rawVal === undefined)
            continue;
        let tokenValue;
        if (rawVal &&
            typeof rawVal === 'object' &&
            'type' in rawVal &&
            rawVal.type === 'alias') {
            const ref = aliasResolver(rawVal.id);
            if (!ref)
                continue;
            tokenValue = `{${ref.replace(/\//g, '.')}}`;
        }
        else {
            tokenValue = scalarToTokenValue(v.resolvedType, rawVal);
        }
        const token = {
            $value: tokenValue,
            $type: figmaTypeToTokenType(v.resolvedType),
        };
        if (v.description)
            token.$description = v.description;
        setNested(group, v.name.split('/'), token);
    }
    return group;
}
function collectionsToTokenFiles(collections) {
    // Build a global ID → name map for alias resolution
    const idToName = new Map();
    for (const col of collections) {
        for (const v of col.variables)
            idToName.set(v.id, v.name);
    }
    const resolver = (id) => { var _a; return (_a = idToName.get(id)) !== null && _a !== void 0 ? _a : null; };
    const result = {};
    for (const col of collections) {
        const isSingle = col.modes.length === 1;
        const fileName = col.name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.json';
        let content;
        if (isSingle) {
            const modeId = col.modes[0].modeId;
            content = buildTokenGroup(col.variables, modeId, resolver);
        }
        else {
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
function hexToRgba(hex) {
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
const MAX_TOKEN_DEPTH = 20;
function flattenGroup(obj, prefix = [], depth = 0) {
    if (depth > MAX_TOKEN_DEPTH)
        return [];
    const out = [];
    for (const [key, val] of Object.entries(obj)) {
        if (key.startsWith('$') || !isSafeKey(key))
            continue;
        const path = [...prefix, key];
        if (val && typeof val === 'object' && '$value' in val) {
            out.push({ path, token: val });
        }
        else {
            out.push(...flattenGroup(val, path, depth + 1));
        }
    }
    return out;
}
function tokenFilesToCollections(files) {
    var _a, _b, _c, _d, _e;
    // Two-pass: first collect all variable names, then resolve aliases
    const collections = [];
    // Collect all variable names for alias resolution in pass 2
    const nameToId = new Map();
    let idCounter = 0;
    const nextId = () => `imported-${idCounter++}`;
    // Pass 1: build structure, assign placeholder IDs
    for (const [, file] of Object.entries(files)) {
        const metadata = file.$metadata;
        const colName = (_a = metadata === null || metadata === void 0 ? void 0 : metadata.collection) !== null && _a !== void 0 ? _a : 'Imported';
        const modes = (_b = metadata === null || metadata === void 0 ? void 0 : metadata.modes) !== null && _b !== void 0 ? _b : [];
        const isSingle = modes.length <= 1;
        const rawModes = [];
        const variableMap = new Map();
        if (isSingle) {
            const modeName = (_c = modes[0]) !== null && _c !== void 0 ? _c : 'Mode 1';
            const modeId = `mode-0`;
            rawModes.push({ modeId, name: modeName });
            const flat = flattenGroup(file);
            for (const { path, token } of flat) {
                const varName = path.join('/');
                const id = nextId();
                nameToId.set(varName, id);
                variableMap.set(varName, {
                    id,
                    name: varName,
                    resolvedType: tokenTypeToFigma(token.$type),
                    description: (_d = token.$description) !== null && _d !== void 0 ? _d : '',
                    valuesByMode: { [modeId]: resolveRawValue(token, varName) },
                });
            }
        }
        else {
            modes.forEach((modeName, i) => rawModes.push({ modeId: `mode-${i}`, name: modeName }));
            for (let i = 0; i < modes.length; i++) {
                const modeId = `mode-${i}`;
                const modeName = modes[i];
                const modeGroup = file[modeName];
                if (!modeGroup)
                    continue;
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
                            description: (_e = token.$description) !== null && _e !== void 0 ? _e : '',
                            valuesByMode: {},
                        });
                    }
                    const v = variableMap.get(varName);
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
                        v.valuesByMode[modeId] = { type: 'alias', id: refId };
                    }
                }
            }
        }
    }
    return collections;
}
// ─── Diff ─────────────────────────────────────────────────────────────────────
function flattenToValueMap(file) {
    var _a;
    const map = new Map();
    const metadata = file.$metadata;
    const modes = (_a = metadata === null || metadata === void 0 ? void 0 : metadata.modes) !== null && _a !== void 0 ? _a : [];
    if (modes.length > 1) {
        for (const mode of modes) {
            const group = file[mode];
            if (!group)
                continue;
            for (const { path, token } of flattenGroup(group)) {
                map.set(`${mode}::${path.join('/')}`, token.$value);
            }
        }
    }
    else {
        for (const { path, token } of flattenGroup(file)) {
            map.set(path.join('/'), token.$value);
        }
    }
    return map;
}
function diffTokenFiles(remoteFiles, localFiles) {
    return Object.entries(remoteFiles).map(([fileName, remoteFile]) => {
        const localFile = localFiles[fileName];
        const remote = flattenToValueMap(remoteFile);
        const local = localFile ? flattenToValueMap(localFile) : new Map();
        let added = 0, updated = 0, removed = 0;
        for (const [path, value] of remote) {
            if (!local.has(path))
                added++;
            else if (JSON.stringify(local.get(path)) !== JSON.stringify(value))
                updated++;
        }
        for (const path of local.keys()) {
            if (!remote.has(path))
                removed++;
        }
        return { fileName, added, updated, removed, hasChanges: added + updated + removed > 0 };
    });
}
function tokenTypeToFigma(type) {
    if (type === 'color')
        return 'COLOR';
    if (type === 'number' || type === 'dimension')
        return 'FLOAT';
    if (type === 'boolean')
        return 'BOOLEAN';
    return 'STRING';
}
function resolveRawValue(token, _varName) {
    const v = token.$value;
    // References are handled in pass 2
    if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}'))
        return v;
    if (token.$type === 'color' && typeof v === 'string')
        return hexToRgba(v);
    return v;
}

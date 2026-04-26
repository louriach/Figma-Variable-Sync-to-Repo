/// <reference types="@figma/plugin-typings" />

import type {
  PluginMessage,
  Settings,
  RawCollection,
  RawVariable,
  RawVariableValue,
  ScalarValue,
  SetVariablesResult,
} from './types';

figma.showUI(__html__, { width: 420, height: 600, title: 'Variable Sync to Repo' });

// ─── Settings ────────────────────────────────────────────────────────────────

async function loadSettings(): Promise<Settings | null> {
  return (await figma.clientStorage.getAsync('settings')) ?? null;
}

async function saveSettings(settings: Settings): Promise<void> {
  await figma.clientStorage.setAsync('settings', settings);
}

// ─── Read Figma variables ────────────────────────────────────────────────────

async function readVariables(): Promise<RawCollection[]> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();

  return collections.map((col) => {
    const variables: RawVariable[] = allVars
      .filter((v) => v.variableCollectionId === col.id)
      .map((v) => {
        const valuesByMode: RawVariable['valuesByMode'] = {};
        for (const [modeId, val] of Object.entries(v.valuesByMode)) {
          if (val && typeof val === 'object' && 'type' in val && val.type === 'VARIABLE_ALIAS') {
            valuesByMode[modeId] = { type: 'alias', id: (val as VariableAlias).id };
          } else {
            valuesByMode[modeId] = val as ScalarValue;
          }
        }
        return {
          id: v.id,
          name: v.name,
          resolvedType: v.resolvedType,
          description: v.description,
          valuesByMode,
        };
      });

    return {
      id: col.id,
      name: col.name,
      modes: col.modes,
      variables,
    };
  });
}

// ─── Apply variables from tokens ─────────────────────────────────────────────

async function applyVariables(
  collections: RawCollection[]
): Promise<SetVariablesResult> {
  const result: SetVariablesResult = { created: 0, updated: 0, errors: [], log: [] };

  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const existingVariables = await figma.variables.getLocalVariablesAsync();

  const colByName = new Map(existingCollections.map((c) => [c.name, c]));
  const varByKey = new Map(existingVariables.map((v) => [`${v.variableCollectionId}::${v.name}`, v]));

  // Maps imported placeholder IDs to real Figma variable IDs
  const importedIdToFigmaId = new Map<string, string>();

  type ColContext = {
    col: VariableCollection;
    remoteModeIdToLocal: Map<string, string>;
    rawVars: RawVariable[];
    colName: string;
  };
  const contexts: ColContext[] = [];

  // Pass 1: create all collections, modes, and variables across every collection
  // before setting any values — ensures aliases can always resolve their targets
  // regardless of collection order or same-collection forward references.
  for (const rawCol of collections) {
    let col = colByName.get(rawCol.name);
    const isNewCollection = !col;
    if (!col) {
      col = figma.variables.createVariableCollection(rawCol.name);
      colByName.set(rawCol.name, col);
    }

    const incomingModeNames = new Set(rawCol.modes.map((m) => m.name));
    const modeByName = new Map(col.modes.map((m) => [m.name, m.modeId]));

    // Add any missing modes (rename the auto-created "Mode 1" for brand-new collections)
    for (let i = 0; i < rawCol.modes.length; i++) {
      const rawMode = rawCol.modes[i];
      if (!modeByName.has(rawMode.name)) {
        // Figma creates a default "Mode 1" when a collection is first made.
        // Rename it to the first incoming mode instead of adding a duplicate.
        if (isNewCollection && i === 0 && col.modes.length === 1) {
          col.renameMode(col.modes[0].modeId, rawMode.name);
          modeByName.delete(col.modes[0].name);
          modeByName.set(rawMode.name, col.modes[0].modeId);
        } else {
          const newId = col.addMode(rawMode.name);
          modeByName.set(rawMode.name, newId);
        }
      }
    }

    // Remove modes that are no longer in the incoming data (e.g. old Light/Dark
    // after switching to Compact/Default/Comfortable). Must add new modes first
    // so Figma always has at least one mode present.
    for (const mode of col.modes) {
      if (!incomingModeNames.has(mode.name)) {
        try { col.removeMode(mode.modeId); } catch { /* ignore */ }
        modeByName.delete(mode.name);
      }
    }

    const remoteModeIdToLocal = new Map<string, string>();
    for (const rawMode of rawCol.modes) {
      const localId = modeByName.get(rawMode.name);
      if (localId) remoteModeIdToLocal.set(rawMode.modeId, localId);
    }

    let colCreated = 0, colUpdated = 0;
    for (const rawVar of rawCol.variables) {
      const figmaType: VariableResolvedDataType =
        rawVar.resolvedType === 'COLOR' ? 'COLOR' :
        rawVar.resolvedType === 'FLOAT' ? 'FLOAT' :
        rawVar.resolvedType === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';

      const key = `${col.id}::${rawVar.name}`;
      let variable = varByKey.get(key);

      if (!variable) {
        try {
          variable = figma.variables.createVariable(rawVar.name, col, figmaType);
          varByKey.set(key, variable);
          result.created++;
          colCreated++;
        } catch (e) {
          result.errors.push(`Create "${rawVar.name}": ${e}`);
          continue;
        }
      } else {
        result.updated++;
        colUpdated++;
      }

      if (rawVar.description) variable.description = rawVar.description;
      importedIdToFigmaId.set(rawVar.id, variable.id);
    }

    result.log.push(
      `${isNewCollection ? '✦' : '↻'} ${rawCol.name}: ${colCreated} created, ${colUpdated} updated`
    );
    contexts.push({ col, remoteModeIdToLocal, rawVars: rawCol.variables, colName: rawCol.name });
  }

  // Pass 2: set all values now that every variable exists.
  // Alias chains of any depth (A→B→C) work because Figma resolves them natively;
  // we only need each variable to point at its direct target.
  for (const { col, remoteModeIdToLocal, rawVars } of contexts) {
    for (const rawVar of rawVars) {
      const variable = varByKey.get(`${col.id}::${rawVar.name}`);
      if (!variable) continue;

      for (const [remoteModeId, rawValue] of Object.entries(rawVar.valuesByMode)) {
        const localModeId = remoteModeIdToLocal.get(remoteModeId);
        if (!localModeId) continue;

        let figmaValue: VariableValue;

        if (rawValue && typeof rawValue === 'object' && 'type' in rawValue &&
            (rawValue as RawVariableValue).type === 'alias') {
          const realId = importedIdToFigmaId.get((rawValue as RawVariableValue).id);
          if (!realId) {
            result.errors.push(`Cannot resolve alias for "${rawVar.name}"`);
            continue;
          }
          figmaValue = { type: 'VARIABLE_ALIAS', id: realId };
        } else {
          figmaValue = rawValue as VariableValue;
        }

        try {
          variable.setValueForMode(localModeId, figmaValue);
        } catch (e) {
          result.errors.push(`Set value for "${rawVar.name}": ${e}`);
        }
      }
    }
  }

  return result;
}

// ─── Message handler ─────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: PluginMessage) => {
  switch (msg.type) {
    case 'GET_SETTINGS': {
      const settings = await loadSettings();
      figma.ui.postMessage({ type: 'SETTINGS_DATA', payload: settings });
      break;
    }

    case 'SAVE_SETTINGS': {
      await saveSettings(msg.payload as Settings);
      break;
    }

    case 'RESET_SETTINGS': {
      await figma.clientStorage.deleteAsync('settings');
      figma.ui.postMessage({ type: 'RESET_COMPLETE' });
      break;
    }

    case 'GET_VARIABLES': {
      try {
        const collections = await readVariables();
        figma.ui.postMessage({ type: 'VARIABLES_DATA', payload: collections });
      } catch (e) {
        figma.ui.postMessage({ type: 'ERROR', payload: String(e) });
      }
      break;
    }

    case 'SET_VARIABLES': {
      try {
        const result = await applyVariables(msg.payload as RawCollection[]);
        figma.ui.postMessage({ type: 'SET_VARIABLES_RESULT', payload: result });
      } catch (e) {
        figma.ui.postMessage({ type: 'ERROR', payload: String(e) });
      }
      break;
    }

    case 'OPEN_URL': {
      figma.openExternal(msg.payload as string);
      break;
    }
  }
};

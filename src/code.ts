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

figma.showUI(__html__, { width: 420, height: 600, title: 'GitHub Token Sync' });

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
  const result: SetVariablesResult = { created: 0, updated: 0, errors: [] };

  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const existingVariables = await figma.variables.getLocalVariablesAsync();

  const colByName = new Map(existingCollections.map((c) => [c.name, c]));
  const varByKey = new Map(existingVariables.map((v) => [`${v.variableCollectionId}::${v.name}`, v]));
  const varById = new Map(existingVariables.map((v) => [v.id, v]));

  for (const rawCol of collections) {
    let col = colByName.get(rawCol.name);
    if (!col) {
      col = figma.variables.createVariableCollection(rawCol.name);
      colByName.set(rawCol.name, col);
    }

    // Reconcile modes
    const modeByName = new Map(col.modes.map((m) => [m.name, m.modeId]));
    for (const rawMode of rawCol.modes) {
      if (!modeByName.has(rawMode.name)) {
        const newId = col.addMode(rawMode.name);
        modeByName.set(rawMode.name, newId);
      }
    }

    // Ensure the mode ID mapping uses the *current* col modes (post-creation)
    const remoteModeIdToLocal = new Map<string, string>();
    for (const rawMode of rawCol.modes) {
      const localId = modeByName.get(rawMode.name);
      if (localId) remoteModeIdToLocal.set(rawMode.modeId, localId);
    }

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
          varById.set(variable.id, variable);
          result.created++;
        } catch (e) {
          result.errors.push(`Create "${rawVar.name}": ${e}`);
          continue;
        }
      } else {
        result.updated++;
      }

      if (rawVar.description) variable.description = rawVar.description;

      for (const [remoteModeId, rawValue] of Object.entries(rawVar.valuesByMode)) {
        const localModeId = remoteModeIdToLocal.get(remoteModeId);
        if (!localModeId) continue;

        let figmaValue: VariableValue;

        if (rawValue && typeof rawValue === 'object' && 'type' in rawValue && (rawValue as RawVariableValue).type === 'alias') {
          const refVar = varById.get((rawValue as RawVariableValue).id);
          if (!refVar) {
            result.errors.push(`Cannot resolve alias for "${rawVar.name}"`);
            continue;
          }
          figmaValue = { type: 'VARIABLE_ALIAS', id: refVar.id };
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
  }
};

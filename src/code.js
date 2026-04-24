"use strict";
/// <reference types="@figma/plugin-typings" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
figma.showUI(__html__, { width: 420, height: 600, title: 'Variable Sync to Repo' });
// ─── Settings ────────────────────────────────────────────────────────────────
function loadSettings() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        return (_a = (yield figma.clientStorage.getAsync('settings'))) !== null && _a !== void 0 ? _a : null;
    });
}
function saveSettings(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        yield figma.clientStorage.setAsync('settings', settings);
    });
}
// ─── Read Figma variables ────────────────────────────────────────────────────
function readVariables() {
    return __awaiter(this, void 0, void 0, function* () {
        const collections = yield figma.variables.getLocalVariableCollectionsAsync();
        const allVars = yield figma.variables.getLocalVariablesAsync();
        return collections.map((col) => {
            const variables = allVars
                .filter((v) => v.variableCollectionId === col.id)
                .map((v) => {
                const valuesByMode = {};
                for (const [modeId, val] of Object.entries(v.valuesByMode)) {
                    if (val && typeof val === 'object' && 'type' in val && val.type === 'VARIABLE_ALIAS') {
                        valuesByMode[modeId] = { type: 'alias', id: val.id };
                    }
                    else {
                        valuesByMode[modeId] = val;
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
    });
}
// ─── Apply variables from tokens ─────────────────────────────────────────────
function applyVariables(collections) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = { created: 0, updated: 0, errors: [] };
        const existingCollections = yield figma.variables.getLocalVariableCollectionsAsync();
        const existingVariables = yield figma.variables.getLocalVariablesAsync();
        const colByName = new Map(existingCollections.map((c) => [c.name, c]));
        const varByKey = new Map(existingVariables.map((v) => [`${v.variableCollectionId}::${v.name}`, v]));
        // Maps imported placeholder IDs to real Figma variable IDs
        const importedIdToFigmaId = new Map();
        const contexts = [];
        // Pass 1: create all collections, modes, and variables across every collection
        // before setting any values — ensures aliases can always resolve their targets
        // regardless of collection order or same-collection forward references.
        for (const rawCol of collections) {
            let col = colByName.get(rawCol.name);
            if (!col) {
                col = figma.variables.createVariableCollection(rawCol.name);
                colByName.set(rawCol.name, col);
            }
            const modeByName = new Map(col.modes.map((m) => [m.name, m.modeId]));
            for (const rawMode of rawCol.modes) {
                if (!modeByName.has(rawMode.name)) {
                    const newId = col.addMode(rawMode.name);
                    modeByName.set(rawMode.name, newId);
                }
            }
            const remoteModeIdToLocal = new Map();
            for (const rawMode of rawCol.modes) {
                const localId = modeByName.get(rawMode.name);
                if (localId)
                    remoteModeIdToLocal.set(rawMode.modeId, localId);
            }
            for (const rawVar of rawCol.variables) {
                const figmaType = rawVar.resolvedType === 'COLOR' ? 'COLOR' :
                    rawVar.resolvedType === 'FLOAT' ? 'FLOAT' :
                        rawVar.resolvedType === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';
                const key = `${col.id}::${rawVar.name}`;
                let variable = varByKey.get(key);
                if (!variable) {
                    try {
                        variable = figma.variables.createVariable(rawVar.name, col, figmaType);
                        varByKey.set(key, variable);
                        result.created++;
                    }
                    catch (e) {
                        result.errors.push(`Create "${rawVar.name}": ${e}`);
                        continue;
                    }
                }
                else {
                    result.updated++;
                }
                if (rawVar.description)
                    variable.description = rawVar.description;
                importedIdToFigmaId.set(rawVar.id, variable.id);
            }
            contexts.push({ col, remoteModeIdToLocal, rawVars: rawCol.variables });
        }
        // Pass 2: set all values now that every variable exists.
        // Alias chains of any depth (A→B→C) work because Figma resolves them natively;
        // we only need each variable to point at its direct target.
        for (const { col, remoteModeIdToLocal, rawVars } of contexts) {
            for (const rawVar of rawVars) {
                const variable = varByKey.get(`${col.id}::${rawVar.name}`);
                if (!variable)
                    continue;
                for (const [remoteModeId, rawValue] of Object.entries(rawVar.valuesByMode)) {
                    const localModeId = remoteModeIdToLocal.get(remoteModeId);
                    if (!localModeId)
                        continue;
                    let figmaValue;
                    if (rawValue && typeof rawValue === 'object' && 'type' in rawValue &&
                        rawValue.type === 'alias') {
                        const realId = importedIdToFigmaId.get(rawValue.id);
                        if (!realId) {
                            result.errors.push(`Cannot resolve alias for "${rawVar.name}"`);
                            continue;
                        }
                        figmaValue = { type: 'VARIABLE_ALIAS', id: realId };
                    }
                    else {
                        figmaValue = rawValue;
                    }
                    try {
                        variable.setValueForMode(localModeId, figmaValue);
                    }
                    catch (e) {
                        result.errors.push(`Set value for "${rawVar.name}": ${e}`);
                    }
                }
            }
        }
        return result;
    });
}
// ─── Message handler ─────────────────────────────────────────────────────────
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    switch (msg.type) {
        case 'GET_SETTINGS': {
            const settings = yield loadSettings();
            figma.ui.postMessage({ type: 'SETTINGS_DATA', payload: settings });
            break;
        }
        case 'SAVE_SETTINGS': {
            yield saveSettings(msg.payload);
            break;
        }
        case 'RESET_SETTINGS': {
            yield figma.clientStorage.deleteAsync('settings');
            figma.ui.postMessage({ type: 'RESET_COMPLETE' });
            break;
        }
        case 'GET_VARIABLES': {
            try {
                const collections = yield readVariables();
                figma.ui.postMessage({ type: 'VARIABLES_DATA', payload: collections });
            }
            catch (e) {
                figma.ui.postMessage({ type: 'ERROR', payload: String(e) });
            }
            break;
        }
        case 'SET_VARIABLES': {
            try {
                const result = yield applyVariables(msg.payload);
                figma.ui.postMessage({ type: 'SET_VARIABLES_RESULT', payload: result });
            }
            catch (e) {
                figma.ui.postMessage({ type: 'ERROR', payload: String(e) });
            }
            break;
        }
        case 'OPEN_URL': {
            figma.openExternal(msg.payload);
            break;
        }
    }
});

// ─── Plugin Messages ────────────────────────────────────────────────────────

export type MessageType =
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'RESET_SETTINGS'
  | 'RESET_COMPLETE'
  | 'GET_VARIABLES'
  | 'SET_VARIABLES'
  | 'SETTINGS_DATA'
  | 'VARIABLES_DATA'
  | 'SET_VARIABLES_RESULT'
  | 'OPEN_URL'
  | 'ERROR';

export interface PluginMessage {
  type: MessageType;
  payload?: unknown;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = 'github' | 'gitlab' | 'bitbucket';

export interface Settings {
  provider: Provider;
  token: string;
  connectedLogin: string;
  owner: string;
  repo: string;
  branch: string;
  tokensPath: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'github',
  token: '',
  connectedLogin: '',
  owner: '',
  repo: '',
  branch: 'main',
  tokensPath: 'tokens/',
};

// ─── W3C DTCG Token Format ──────────────────────────────────────────────────

export type TokenType =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'duration'
  | 'cubicBezier'
  | 'number'
  | 'string'
  | 'boolean';

export interface DesignToken {
  $value: string | number | boolean;
  $type: TokenType;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

export type TokenGroup = {
  [key: string]: DesignToken | TokenGroup;
};

export interface TokenFile {
  $schema?: string;
  $metadata?: {
    collection: string;
    modes: string[];
  };
  [key: string]: unknown;
}

// ─── Raw Figma variable data (serialisable for postMessage) ─────────────────

export interface RawVariableValue {
  type: 'alias';
  id: string;
}

export type ScalarValue = string | number | boolean | { r: number; g: number; b: number; a: number };

export interface RawVariable {
  id: string;
  name: string;
  resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  description: string;
  valuesByMode: Record<string, ScalarValue | RawVariableValue>;
}

export interface RawMode {
  modeId: string;
  name: string;
}

export interface RawCollection {
  id: string;
  name: string;
  modes: RawMode[];
  variables: RawVariable[];
}

// ─── Set variables result ────────────────────────────────────────────────────

export interface SetVariablesResult {
  created: number;
  updated: number;
  errors: string[];
}

// ─── Pull diff ───────────────────────────────────────────────────────────────

export interface FileDiff {
  fileName: string;
  added: number;
  updated: number;
  removed: number;
  hasChanges: boolean;
}

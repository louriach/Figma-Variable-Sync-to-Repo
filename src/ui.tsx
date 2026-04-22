import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Settings,
  PluginMessage,
  RawCollection,
  TokenFile,
  SetVariablesResult,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { GitHubProvider } from './lib/github';
import { GitLabProvider } from './lib/gitlab';
import { collectionsToTokenFiles, tokenFilesToCollections } from './lib/tokens';
import type { GitProvider } from './lib/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildProvider(s: Settings): GitProvider {
  if (s.provider === 'gitlab') return new GitLabProvider(s.token, s.owner, s.repo, s.branch);
  return new GitHubProvider(s.token, s.owner, s.repo, s.branch);
}

function normaliseTokensPath(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DotState = 'idle' | 'working' | 'ok' | 'error';

interface LogLine {
  text: string;
  kind: 'info' | 'ok' | 'error';
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<'sync' | 'settings'>('sync');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dot, setDot] = useState<DotState>('idle');
  const [statusText, setStatusText] = useState('Ready');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [tokenValidated, setTokenValidated] = useState<boolean | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Communication with code.ts ──
  const postMsg = useCallback((msg: PluginMessage) => {
    parent.postMessage({ pluginMessage: msg }, '*');
  }, []);

  useEffect(() => {
    postMsg({ type: 'GET_SETTINGS' });

    const handler = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as PluginMessage | undefined;
      if (!msg) return;
      handlePluginMessage(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs((prev) => [...prev, { text, kind }]);
  }, []);

  const clearLogs = () => setLogs([]);

  const setStatus = useCallback((text: string, state: DotState) => {
    setStatusText(text);
    setDot(state);
  }, []);

  // Pending resolver refs for code.ts responses
  const variablesResolver = useRef<((c: RawCollection[]) => void) | null>(null);
  const setVarsResolver = useRef<((r: SetVariablesResult) => void) | null>(null);

  function handlePluginMessage(msg: PluginMessage) {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        if (msg.payload) setSettings(msg.payload as Settings);
        break;
      case 'VARIABLES_DATA':
        variablesResolver.current?.(msg.payload as RawCollection[]);
        variablesResolver.current = null;
        break;
      case 'SET_VARIABLES_RESULT':
        setVarsResolver.current?.(msg.payload as SetVariablesResult);
        setVarsResolver.current = null;
        break;
      case 'ERROR':
        addLog(String(msg.payload), 'error');
        setStatus(String(msg.payload), 'error');
        setBusy(false);
        break;
    }
  }

  function getVariables(): Promise<RawCollection[]> {
    return new Promise((resolve) => {
      variablesResolver.current = resolve;
      postMsg({ type: 'GET_VARIABLES' });
    });
  }

  function applyVariables(collections: RawCollection[]): Promise<SetVariablesResult> {
    return new Promise((resolve) => {
      setVarsResolver.current = resolve;
      postMsg({ type: 'SET_VARIABLES', payload: collections });
    });
  }

  // ── Push: Figma → GitHub ──
  async function handlePush() {
    if (!validateSettings()) return;
    setBusy(true);
    clearLogs();
    setStatus('Reading Figma variables…', 'working');

    try {
      const collections = await getVariables();
      addLog(`Found ${collections.length} collection(s)`);

      const tokenFiles = collectionsToTokenFiles(collections);
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);

      for (const { fileName, content } of Object.values(tokenFiles)) {
        const filePath = basePath + fileName;
        setStatus(`Pushing ${fileName}…`, 'working');
        addLog(`→ ${filePath}`);

        const existing = await provider.getFile(filePath);
        const json = JSON.stringify(content, null, 2);
        await provider.putFile(
          filePath,
          json,
          `chore: sync tokens from Figma (${fileName})`,
          existing?.sha
        );
        addLog(`✓ ${fileName} pushed`, 'ok');
      }

      setStatus(`Pushed ${Object.keys(tokenFiles).length} file(s)`, 'ok');
      addLog('Done!', 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(msg, 'error');
      setStatus('Push failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Pull: GitHub → Figma ──
  async function handlePull() {
    if (!validateSettings()) return;
    setBusy(true);
    clearLogs();
    setStatus('Listing token files…', 'working');

    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const files = await provider.listFiles(basePath);

      if (files.length === 0) {
        addLog('No JSON files found in the tokens path.', 'error');
        setStatus('No files found', 'error');
        setBusy(false);
        return;
      }

      addLog(`Found ${files.length} file(s)`);
      const tokenFiles: Record<string, TokenFile> = {};

      for (const f of files) {
        setStatus(`Downloading ${f.name}…`, 'working');
        addLog(`← ${f.path}`);
        const fc = await provider.getFile(f.path);
        if (!fc) { addLog(`  (skipped — not found)`, 'error'); continue; }
        tokenFiles[f.name] = JSON.parse(fc.content) as TokenFile;
        addLog(`✓ ${f.name} downloaded`, 'ok');
      }

      setStatus('Applying to Figma…', 'working');
      const collections = tokenFilesToCollections(tokenFiles);
      const result = await applyVariables(collections);

      addLog(`Created ${result.created} variable(s), updated ${result.updated}`, 'ok');
      if (result.errors.length) {
        result.errors.forEach((e) => addLog(`  ⚠ ${e}`, 'error'));
      }
      setStatus(`Applied ${result.created + result.updated} variable(s)`, 'ok');
      addLog('Done!', 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(msg, 'error');
      setStatus('Pull failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Validate token ──
  async function handleValidateToken() {
    if (!settings.token || !settings.owner || !settings.repo) return;
    try {
      const provider = buildProvider(settings);
      const { login } = await provider.validateToken();
      setTokenValidated(true);
      addLog(`Authenticated as ${login}`, 'ok');
    } catch (e) {
      setTokenValidated(false);
      addLog(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  function validateSettings(): boolean {
    if (!settings.token) { addLog('Token is required', 'error'); setStatus('Token missing', 'error'); return false; }
    if (!settings.owner) { addLog('Owner is required', 'error'); setStatus('Owner missing', 'error'); return false; }
    if (!settings.repo)  { addLog('Repo is required', 'error');  setStatus('Repo missing', 'error');  return false; }
    return true;
  }

  function saveSettings() {
    postMsg({ type: 'SAVE_SETTINGS', payload: settings });
    setStatus('Settings saved', 'ok');
  }

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setTokenValidated(null);
  };

  // ── Render ──
  return (
    <>
      <div className="status-bar">
        <div className={`dot ${dot}`} />
        <span className="status-text">{statusText}</span>
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'sync' ? ' active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
        <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
      </div>

      {tab === 'sync' && (
        <div className="panel">
          <div className="sync-card">
            <h3>↑ Push to {settings.provider === 'gitlab' ? 'GitLab' : 'GitHub'}</h3>
            <p>Export all Figma variable collections as W3C design token JSON files.</p>
            <button className="btn btn-primary" disabled={busy} onClick={handlePush}>
              {busy ? 'Working…' : 'Push tokens'}
            </button>
          </div>

          <div className="sync-card">
            <h3>↓ Pull from {settings.provider === 'gitlab' ? 'GitLab' : 'GitHub'}</h3>
            <p>Import W3C design token JSON files and create/update Figma variables.</p>
            <button className="btn btn-secondary" disabled={busy} onClick={handlePull}>
              {busy ? 'Working…' : 'Pull tokens'}
            </button>
          </div>

          {logs.length > 0 && (
            <div className="log-area" ref={logRef}>
              {logs.map((l, i) => (
                <div key={i} className={l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : ''}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="panel">
          <div className="section-title">Provider</div>

          <div className="field">
            <label>Git Provider</label>
            <select
              value={settings.provider}
              onChange={(e) => updateSetting('provider', e.target.value as Settings['provider'])}
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </div>

          <hr className="divider" />
          <div className="section-title">Authentication</div>

          <div className="field">
            <label>{settings.provider === 'gitlab' ? 'Personal Access Token (api scope)' : 'Personal Access Token (repo scope)'}</label>
            <input
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
              value={settings.token}
              onChange={(e) => updateSetting('token', e.target.value)}
            />
            <div className={`hint${tokenValidated === true ? ' ok' : tokenValidated === false ? ' error' : ''}`}>
              {tokenValidated === true ? '✓ Token valid' : tokenValidated === false ? '✗ Token invalid' : 'Token is stored locally in Figma only.'}
            </div>
          </div>

          <hr className="divider" />
          <div className="section-title">Repository</div>

          <div className="field">
            <label>Owner (user or organisation)</label>
            <input
              type="text"
              placeholder="louriach"
              value={settings.owner}
              onChange={(e) => updateSetting('owner', e.target.value)}
            />
          </div>

          <div className="field">
            <label>Repository</label>
            <input
              type="text"
              placeholder="Figma-Github-token-sync"
              value={settings.repo}
              onChange={(e) => updateSetting('repo', e.target.value)}
            />
          </div>

          <div className="field">
            <label>Branch</label>
            <input
              type="text"
              placeholder="main"
              value={settings.branch}
              onChange={(e) => updateSetting('branch', e.target.value)}
            />
          </div>

          <div className="field">
            <label>Tokens path in repo</label>
            <input
              type="text"
              placeholder="tokens/"
              value={settings.tokensPath}
              onChange={(e) => updateSetting('tokensPath', e.target.value)}
            />
            <div className="hint">Directory where token JSON files are stored.</div>
          </div>

          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleValidateToken} disabled={!settings.token || !settings.owner || !settings.repo}>
              Test connection
            </button>
            <button className="btn btn-primary" onClick={saveSettings}>
              Save settings
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

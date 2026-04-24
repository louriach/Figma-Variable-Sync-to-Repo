import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Settings,
  PluginMessage,
  RawCollection,
  TokenFile,
  SetVariablesResult,
  FileDiff,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { GitHubProvider } from './lib/github';
import { GitLabProvider } from './lib/gitlab';
import { BitbucketProvider } from './lib/bitbucket';
import { collectionsToTokenFiles, tokenFilesToCollections, diffTokenFiles } from './lib/tokens';
import type { GitProvider } from './lib/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildProvider(s: Settings): GitProvider {
  if (s.provider === 'gitlab') return new GitLabProvider(s.token, s.owner, s.repo, s.branch);
  if (s.provider === 'bitbucket') return new BitbucketProvider(s.token, s.owner, s.repo, s.branch);
  return new GitHubProvider(s.token, s.owner, s.repo, s.branch);
}

function normaliseTokensPath(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, ...rest] = fullName.split('/');
  return { owner, repo: rest.join('/') };
}

type DotState = 'idle' | 'working' | 'ok' | 'error';
type Tab = 'welcome' | 'sync' | 'settings';
interface LogLine { text: string; kind: 'info' | 'ok' | 'error'; }

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<Tab>('welcome');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dot, setDot] = useState<DotState>('idle');
  const [statusText, setStatusText] = useState('Ready');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingPull, setPendingPull] = useState<{ files: Record<string, TokenFile>; diffs: FileDiff[] } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const [resetSuccess, setResetSuccess] = useState(false);
  const [patValue, setPatValue] = useState('');
  const [patValidating, setPatValidating] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [repoFullName, setRepoFullName] = useState('');

  const setupRef = useRef<HTMLElement>(null);

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

  const setStatus = useCallback((text: string, state: DotState) => {
    setStatusText(text);
    setDot(state);
  }, []);

  const variablesResolver = useRef<((c: RawCollection[]) => void) | null>(null);
  const setVarsResolver = useRef<((r: SetVariablesResult) => void) | null>(null);

  function handlePluginMessage(msg: PluginMessage) {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        if (msg.payload) {
          const s = msg.payload as Settings;
          setSettings(s);
          if (s.owner && s.repo) setRepoFullName(`${s.owner}/${s.repo}`);
          if (s.token && s.owner && s.repo && s.branch) {
            setTab('sync');
          } else if (s.token) {
            setTab('settings');
          }
        }
        break;
      case 'RESET_COMPLETE':
        setSettings(DEFAULT_SETTINGS);
        setRepoFullName('');
        setRepos([]);
        setBranches([]);
        setPatValue('');
        setDot('idle');
        setStatusText('Ready');
        setResetSuccess(true);
        setTab('welcome');
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

  function scrollToSetup() {
    setupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Connect with PAT ──
  async function handleConnect() {
    if (!patValue) return;
    setPatValidating(true);
    try {
      const provider: GitProvider =
        settings.provider === 'gitlab' ? new GitLabProvider(patValue, '', '', '') :
        settings.provider === 'bitbucket' ? new BitbucketProvider(patValue, '', '', '') :
        new GitHubProvider(patValue, '', '', '');
      const { login } = await provider.validateToken();
      const updated = { ...settings, token: patValue, connectedLogin: login };
      setSettings(updated);
      postMsg({ type: 'SAVE_SETTINGS', payload: updated });
      setStatus(`Connected as ${login}`, 'ok');
      await loadRepos(patValue);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Token rejected', 'error');
    } finally {
      setPatValidating(false);
    }
  }

  function handleDisconnect() {
    const updated = { ...DEFAULT_SETTINGS, provider: settings.provider };
    setSettings(updated);
    setRepoFullName('');
    setRepos([]);
    setBranches([]);
    setPatValue('');
    postMsg({ type: 'SAVE_SETTINGS', payload: updated });
    setStatus('Disconnected', 'idle');
    setTab('settings');
  }

  function handleReset() {
    setResetSuccess(false);
    postMsg({ type: 'RESET_SETTINGS' });
  }

  // ── Repo / branch loading ──
  async function loadRepos(token: string) {
    setReposLoading(true);
    try {
      const p: GitProvider =
        settings.provider === 'gitlab' ? new GitLabProvider(token, '', '', '') :
        settings.provider === 'bitbucket' ? new BitbucketProvider(token, '', '', '') :
        new GitHubProvider(token, '', '', '');
      setRepos(await p.listRepos());
    } catch { /* ignore */ } finally {
      setReposLoading(false);
    }
  }

  async function handleRepoChange(fullName: string) {
    setRepoFullName(fullName);
    const { owner, repo } = splitFullName(fullName);
    setSettings((prev) => ({ ...prev, owner, repo, branch: '' }));
    setBranches([]);
    if (!owner || !repo) return;
    setBranchesLoading(true);
    try {
      const p: GitProvider =
        settings.provider === 'gitlab' ? new GitLabProvider(settings.token, owner, repo, '') :
        settings.provider === 'bitbucket' ? new BitbucketProvider(settings.token, owner, repo, '') :
        new GitHubProvider(settings.token, owner, repo, '');
      const list = await p.listBranches(owner, repo);
      setBranches(list);
      if (list.length > 0) setSettings((prev) => ({ ...prev, branch: list[0] }));
    } catch { /* ignore */ } finally {
      setBranchesLoading(false);
    }
  }

  // ── Push ──
  async function handlePush() {
    if (!validateSettings()) return;
    setBusy(true);
    setLogs([]);
    setStatus('Reading Figma variables…', 'working');
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const created = await provider.ensureBranch(settings.owner, settings.repo, settings.branch);
      if (created) addLog(`Created branch "${settings.branch}" from default branch`, 'ok');
      const collections = await getVariables();
      addLog(`Found ${collections.length} collection(s)`);
      const tokenFiles = collectionsToTokenFiles(collections);
      for (const { fileName, content } of Object.values(tokenFiles)) {
        const filePath = basePath + fileName;
        setStatus(`Pushing ${fileName}…`, 'working');
        addLog(`→ ${filePath}`);
        const existing = await provider.getFile(filePath);
        await provider.putFile(filePath, JSON.stringify(content, null, 2), `chore: sync tokens from Figma (${fileName})`, existing?.sha);
        addLog(`✓ ${fileName} pushed`, 'ok');
      }
      setStatus(`Pushed ${Object.keys(tokenFiles).length} file(s)`, 'ok');
      addLog('Done!', 'ok');
    } catch (e) {
      addLog(e instanceof Error ? e.message : String(e), 'error');
      setStatus('Push failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Pull ──
  async function handlePull() {
    if (!validateSettings()) return;
    setBusy(true);
    setLogs([]);
    setPendingPull(null);
    setStatus('Listing token files…', 'working');
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const files = await provider.listFiles(basePath);
      if (files.length === 0) {
        addLog('No JSON files found at the tokens path.', 'error');
        setStatus('No files found', 'error');
        setBusy(false);
        return;
      }
      addLog(`Found ${files.length} file(s)`);
      const remoteFiles: Record<string, TokenFile> = {};
      for (const f of files) {
        setStatus(`Downloading ${f.name}…`, 'working');
        addLog(`← ${f.path}`);
        const fc = await provider.getFile(f.path);
        if (!fc) { addLog(`  ✗ ${f.name} not found — skipped`, 'error'); continue; }
        try {
          remoteFiles[f.name] = JSON.parse(fc.content) as TokenFile;
          addLog(`✓ ${f.name} downloaded`, 'ok');
        } catch {
          addLog(`  ✗ ${f.name} is not valid JSON — skipped`, 'error');
        }
      }
      if (Object.keys(remoteFiles).length === 0) {
        setStatus('No valid files found', 'error');
        setBusy(false);
        return;
      }
      setStatus('Comparing with local variables…', 'working');
      const localCollections = await getVariables();
      const localFiles = Object.values(collectionsToTokenFiles(localCollections))
        .reduce<Record<string, TokenFile>>((acc, { fileName, content }) => {
          acc[fileName] = content;
          return acc;
        }, {});
      const diffs = diffTokenFiles(remoteFiles, localFiles);
      setPendingPull({ files: remoteFiles, diffs });
      setStatus('Review changes before applying', 'idle');
    } catch (e) {
      addLog(e instanceof Error ? e.message : String(e), 'error');
      setStatus('Pull failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmPull() {
    if (!pendingPull) return;
    setBusy(true);
    setStatus('Applying to Figma…', 'working');
    try {
      const collections = tokenFilesToCollections(pendingPull.files);
      const result = await applyVariables(collections);
      addLog(`Created ${result.created} variable(s), updated ${result.updated}`, 'ok');
      result.errors.forEach((e) => addLog(`  ⚠ ${e}`, 'error'));
      setStatus(`Applied ${result.created + result.updated} variable(s)`, 'ok');
      addLog('Done!', 'ok');
      setPendingPull(null);
    } catch (e) {
      addLog(e instanceof Error ? e.message : String(e), 'error');
      setStatus('Pull failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function validateSettings(): boolean {
    const problems = [
      !settings.token  && 'Not connected — add your token in Settings',
      !settings.owner  && 'No repository selected',
      !settings.repo   && 'No repository selected',
      !settings.branch && 'No branch selected',
    ].filter(Boolean) as string[];
    if (problems.length) {
      problems.forEach((p) => addLog(p, 'error'));
      setStatus(problems[0], 'error');
      return false;
    }
    return true;
  }

  function saveSettings() {
    postMsg({ type: 'SAVE_SETTINGS', payload: settings });
    setStatus('Settings saved', 'ok');
    if (settings.token && settings.owner && settings.repo && settings.branch) setTab('sync');
  }

  const isConnected = !!settings.token && !!settings.connectedLogin;
  const providerLabel =
    settings.provider === 'gitlab' ? 'GitLab' :
    settings.provider === 'bitbucket' ? 'Bitbucket' : 'GitHub';
  const patPlaceholder =
    settings.provider === 'gitlab' ? 'glpat-…' :
    settings.provider === 'bitbucket' ? 'username:app_password' :
    'github_pat_…';
  const patDocsUrl =
    settings.provider === 'gitlab' ? 'https://gitlab.com/-/user_settings/personal_access_tokens' :
    settings.provider === 'bitbucket' ? 'https://bitbucket.org/account/settings/app-passwords' :
    'https://github.com/settings/personal-access-tokens/new';
  const patHint =
    settings.provider === 'bitbucket'
      ? <>Enter as <code style={{fontFamily:'monospace',fontSize:10}}>username:app_password</code>. Needs Repositories: Read &amp; Write scope. Stored locally in Figma only.{' '}<a href={patDocsUrl} target="_blank" rel="noreferrer">Create app password ↗</a></>
      : <>Needs Contents: Read &amp; Write scope. Stored locally in Figma only.{' '}<a href={patDocsUrl} target="_blank" rel="noreferrer">Create one ↗</a></>;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Welcome / onboarding (scrollable two-section page) ── */}
      {tab === 'welcome' && (
        <div className="welcome-page">

          {/* Section 1 — Hero */}
          <section className="welcome-hero">
            {resetSuccess && (
              <div className="welcome-reset-banner">All saved data cleared.</div>
            )}

            <div className="welcome-eyebrow">Variable Sync to Repo</div>

            <div className="welcome-visual">
              <div className="welcome-video">
                <div className="welcome-play" />
              </div>
              <span className="welcome-video-label">Video walkthrough · coming soon</span>
            </div>

            <div className="welcome-text">
              <p className="welcome-lead">Sync Figma variables to</p>
              <div className="provider-pills">
                <span className="provider-pill">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                  GitHub
                </span>
                <span className="provider-pill">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.45.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.444a.92.92 0 00.33-1.023" />
                  </svg>
                  GitLab
                </span>
                <span className="provider-pill">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
                  </svg>
                  Bitbucket
                </span>
              </div>
              <p className="welcome-desc">Push variables from Figma to your repo, or pull them back — all as W3C design tokens, with no manual copying.</p>
            </div>

            <div className="welcome-cta">
              <button className="btn btn-primary btn-full" onClick={scrollToSetup}>
                Get started
              </button>
              <p className="welcome-security">Your variables are stored locally in Figma only, never on our servers.</p>
            </div>
          </section>

          {/* Section 2 — Setup form */}
          <section className="welcome-setup" ref={setupRef}>
            <div className="setup-header">
              <h2 className="setup-title">Connect your account</h2>
              <p className="setup-sub">
                {isConnected
                  ? 'Now choose a repository and branch to sync with.'
                  : 'Paste a personal access token to authenticate with your provider.'}
              </p>
            </div>

            <div className="field">
              <label>Git Provider</label>
              <select
                value={settings.provider}
                onChange={(e) => {
                  setSettings((prev) => ({ ...prev, provider: e.target.value as Settings['provider'] }));
                  setRepos([]);
                  setBranches([]);
                }}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
                <option value="bitbucket">Bitbucket</option>
              </select>
            </div>

            <div className="setup-divider" />

            {isConnected ? (
              <div className="connected-card">
                <div className="connected-avatar">{settings.connectedLogin.charAt(0).toUpperCase()}</div>
                <div className="connected-info">
                  <div className="connected-name">@{settings.connectedLogin}</div>
                  <div className="connected-sub">Connected to {providerLabel}</div>
                </div>
                <button className="btn-danger-ghost" onClick={handleDisconnect}>Disconnect</button>
              </div>
            ) : (
              <div className="field">
                <label>Personal Access Token</label>
                <div className="input-row">
                  <input
                    type="password"
                    placeholder={patPlaceholder}
                    value={patValue}
                    onChange={(e) => setPatValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                  />
                  <button
                    className="btn btn-primary btn-inline"
                    onClick={handleConnect}
                    disabled={!patValue || patValidating}
                  >
                    {patValidating ? '…' : 'Connect'}
                  </button>
                </div>
                <div className="hint">
                  {patHint}
                </div>
              </div>
            )}

            {isConnected && (
              <>
                <div className="setup-divider" />

                <div className="field">
                  <label>Repository {reposLoading && <span className="loading-label">Loading…</span>}</label>
                  {repos.length > 0 ? (
                    <select value={repoFullName} onChange={(e) => handleRepoChange(e.target.value)}>
                      <option value="">— select a repository —</option>
                      {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <input type="text" placeholder="owner/repo-name" value={repoFullName} onChange={(e) => handleRepoChange(e.target.value)} />
                  )}
                </div>

                <div className="field">
                  <label>Branch {branchesLoading && <span className="loading-label">Loading…</span>}</label>
                  <input
                    list="branch-datalist"
                    placeholder="main"
                    value={settings.branch}
                    onChange={(e) => setSettings((prev) => ({ ...prev, branch: e.target.value }))}
                  />
                  <datalist id="branch-datalist">
                    {branches.map((b) => <option key={b} value={b} />)}
                  </datalist>
                  {settings.branch && !branches.includes(settings.branch) && branches.length > 0 && (
                    <div className="hint ok">✓ "{settings.branch}" will be created on first push</div>
                  )}
                </div>

                <div className="field">
                  <label>Tokens path</label>
                  <input
                    type="text"
                    placeholder="tokens/"
                    value={settings.tokensPath}
                    onChange={(e) => setSettings((prev) => ({ ...prev, tokensPath: e.target.value }))}
                  />
                  <div className="hint">Directory in your repo where token JSON files are stored.</div>
                </div>

                <button className="btn btn-primary btn-full" style={{ marginTop: 20 }} onClick={saveSettings}>
                  Start syncing →
                </button>
              </>
            )}

            <p className="setup-footer">
              Settings are saved locally in Figma — you won't need to reconnect next time.
            </p>
          </section>
        </div>
      )}

      {/* ── Main UI (sync + settings tabs) ── */}
      {tab !== 'welcome' && (
        <>
          <div className="status-bar">
            <div className={`dot ${dot}`} />
            <span className="status-text">{statusText}</span>
          </div>

          <div className="tabs">
            <button className={`tab${tab === 'sync' ? ' active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
            <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
          </div>

          {/* ── Sync tab ── */}
          {tab === 'sync' && (
            <div className="panel">
              {!isConnected && (
                <div className="notice">Connect your repository in <strong>Settings</strong> before syncing.</div>
              )}
              <div className="sync-card">
                <h3>↑ Push to {providerLabel}</h3>
                <p>Export all Figma variable collections as W3C design token JSON files.</p>
                <button className="btn btn-primary" disabled={busy} onClick={handlePush}>
                  {busy ? 'Working…' : 'Push tokens'}
                </button>
              </div>
              <div className="sync-card">
                <h3>↓ Pull from {providerLabel}</h3>
                <p>Import W3C design token JSON files and create/update Figma variables.</p>
                <button className="btn btn-secondary" disabled={busy} onClick={handlePull}>
                  {busy ? 'Working…' : 'Pull tokens'}
                </button>
              </div>
              {pendingPull && (
                <div className="diff-panel">
                  <div className="diff-header">Changes from remote</div>
                  {pendingPull.diffs.map((d) => (
                    <div key={d.fileName} className="diff-file-row">
                      <span className="diff-file-name">{d.fileName}</span>
                      <span className="diff-stats">
                        {!d.hasChanges && <span className="diff-none">no changes</span>}
                        {d.updated > 0 && <span className="diff-updated">{d.updated} updated</span>}
                        {d.added > 0 && <span className="diff-added">+{d.added} added</span>}
                        {d.removed > 0 && <span className="diff-removed">−{d.removed} removed</span>}
                      </span>
                    </div>
                  ))}
                  <p className="diff-hint">Before applying, save a version in Figma (Menu → Save to version history) as a restore point.</p>
                  <div className="btn-row">
                    <button className="btn btn-primary" onClick={handleConfirmPull} disabled={busy}>Apply changes</button>
                    <button className="btn btn-secondary" onClick={() => { setPendingPull(null); setLogs([]); }} disabled={busy}>Cancel</button>
                  </div>
                </div>
              )}
              {!pendingPull && logs.length > 0 && (
                <div className="log-area" ref={logRef}>
                  {logs.map((l, i) => (
                    <div key={i} className={l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : ''}>{l.text}</div>
                  ))}
                </div>
              )}
              <p className="persist-note" style={{ marginTop: 16 }}>
                New here?{' '}
                <button className="btn-link" onClick={() => postMsg({ type: 'OPEN_URL', payload: 'https://github.com/louriach/Figma-Github-token-sync/tree/main/examples' })}>
                  Try the example token files →
                </button>
              </p>
            </div>
          )}

          {/* ── Settings tab ── */}
          {tab === 'settings' && (
            <div className="panel">
              <div className="section-title">Provider</div>
              <div className="field">
                <label>Git Provider</label>
                <select
                  value={settings.provider}
                  onChange={(e) => {
                    setSettings((prev) => ({ ...prev, provider: e.target.value as Settings['provider'] }));
                    setRepos([]);
                    setBranches([]);
                  }}
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="bitbucket">Bitbucket</option>
                </select>
              </div>

              <hr className="divider" />
              <div className="section-title">Authentication</div>

              {isConnected ? (
                <div className="connected-card">
                  <div className="connected-avatar">{settings.connectedLogin.charAt(0).toUpperCase()}</div>
                  <div className="connected-info">
                    <div className="connected-name">@{settings.connectedLogin}</div>
                    <div className="connected-sub">Connected to {providerLabel}</div>
                  </div>
                  <button className="btn-danger-ghost" onClick={handleDisconnect}>Disconnect</button>
                </div>
              ) : (
                <div className="field">
                  <label>Personal Access Token</label>
                  <div className="input-row">
                    <input
                      type="password"
                      placeholder={patPlaceholder}
                      value={patValue}
                      onChange={(e) => setPatValue(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    />
                    <button
                      className="btn btn-primary btn-inline"
                      onClick={handleConnect}
                      disabled={!patValue || patValidating}
                    >
                      {patValidating ? '…' : 'Connect'}
                    </button>
                  </div>
                  <div className="hint">{patHint}</div>
                </div>
              )}

              {isConnected && (
                <>
                  <hr className="divider" />
                  <div className="section-title">Repository</div>

                  <div className="field">
                    <label>Repository {reposLoading && <span className="loading-label">Loading…</span>}</label>
                    {repos.length > 0 ? (
                      <select value={repoFullName} onChange={(e) => handleRepoChange(e.target.value)}>
                        <option value="">— select a repository —</option>
                        {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <input type="text" placeholder="owner/repo-name" value={repoFullName} onChange={(e) => handleRepoChange(e.target.value)} />
                    )}
                  </div>

                  <div className="field">
                    <label>Branch {branchesLoading && <span className="loading-label">Loading…</span>}</label>
                    <input
                      list="branch-datalist"
                      placeholder="main"
                      value={settings.branch}
                      onChange={(e) => setSettings((prev) => ({ ...prev, branch: e.target.value }))}
                    />
                    <datalist id="branch-datalist">
                      {branches.map((b) => <option key={b} value={b} />)}
                    </datalist>
                    {settings.branch && !branches.includes(settings.branch) && branches.length > 0 && (
                      <div className="hint ok">✓ "{settings.branch}" will be created on first push</div>
                    )}
                  </div>

                  <div className="field">
                    <label>Tokens path</label>
                    <input
                      type="text"
                      placeholder="tokens/"
                      value={settings.tokensPath}
                      onChange={(e) => setSettings((prev) => ({ ...prev, tokensPath: e.target.value }))}
                    />
                    <div className="hint">Directory where token JSON files are stored.</div>
                  </div>

                  <div className="btn-row">
                    <button className="btn btn-primary" onClick={saveSettings}>Save settings</button>
                  </div>
                </>
              )}

              <div className="persist-note">
                Settings are saved locally in Figma — you won't need to reconnect next time.
                <br />
                <button className="btn-link" onClick={handleReset}>Reset all saved data</button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

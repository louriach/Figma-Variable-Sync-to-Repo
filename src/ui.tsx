import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Settings,
  PluginMessage,
  RawCollection,
  TokenFile,
  SetVariablesResult,
  FileDiff,
  OperationRecord,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { GitHubProvider } from './lib/github';
import { GitLabProvider } from './lib/gitlab';
import { BitbucketProvider } from './lib/bitbucket';
import { collectionsToTokenFiles, tokenFilesToCollections, diffTokenFiles } from './lib/tokens';
import type { GitProvider } from './lib/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countTokenFileStats(file: TokenFile): { variables: number; modes: number } {
  const metadata = file.$metadata as { modes?: string[] } | undefined;
  const modes = metadata?.modes ?? [];
  const modeCount = Math.max(modes.length, 1);

  function countLeaves(obj: Record<string, unknown>): number {
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$')) continue;
      if (v && typeof v === 'object' && '$value' in (v as object)) n++;
      else if (v && typeof v === 'object') n += countLeaves(v as Record<string, unknown>);
    }
    return n;
  }

  const variables = modeCount > 1
    ? countLeaves((file[modes[0]] ?? {}) as Record<string, unknown>)
    : countLeaves(file as unknown as Record<string, unknown>);

  return { variables, modes: modeCount };
}

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
type Tab = 'welcome' | 'home' | 'push' | 'pull' | 'log' | 'settings';
interface LogLine { text: string; kind: 'info' | 'ok' | 'error'; }

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<Tab>('welcome');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dot, setDot] = useState<DotState>('idle');
  const [statusText, setStatusText] = useState('Ready');
  const [statusTab, setStatusTab] = useState<Tab>('home');
  const [pushLogs, setPushLogs] = useState<LogLine[]>([]);
  const [pullLogs, setPullLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [pushSelection, setPushSelection] = useState<{ tokenFiles: Record<string, { colId: string; fileName: string; content: TokenFile; modeCount: number; variableCount: number }>; selected: Set<string> } | null>(null);
  const [pullData, setPullData] = useState<{ rows: Array<{ name: string; path: string; content: TokenFile; variables: number; modes: number; diff: FileDiff }>; selected: Set<string> } | null>(null);
  const [history, setHistory] = useState<OperationRecord[]>([]);
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [diffDetail, setDiffDetail] = useState<string | null>(null);
  const pushLogRef = useRef<HTMLDivElement>(null);
  const pullLogRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<Tab>('welcome');
  const loadPushCollectionsRef = useRef<(preserveSelection?: boolean) => Promise<void>>(async () => {});
  const loadPullFilesRef = useRef<() => Promise<void>>(async () => {});

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
    postMsg({ type: 'GET_HISTORY' });
    const handler = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as PluginMessage | undefined;
      if (!msg) return;
      handlePluginMessage(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pushLogRef.current) pushLogRef.current.scrollTop = pushLogRef.current.scrollHeight;
  }, [pushLogs]);
  useEffect(() => {
    if (pullLogRef.current) pullLogRef.current.scrollTop = pullLogRef.current.scrollHeight;
  }, [pullLogs]);


  const addPushLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setPushLogs((prev) => [...prev, { text, kind }]);
  }, []);
  const addPullLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setPullLogs((prev) => [...prev, { text, kind }]);
  }, []);

  const setStatus = useCallback((text: string, state: DotState) => {
    setStatusText(text);
    setDot(state);
    setStatusTab(tabRef.current);
  }, []);

  // Reset status when navigating so it doesn't bleed across tabs.
  // Use refs so we always call the latest version of the loader functions
  // rather than the stale closures captured when navigateTo was first created.
  const navigateTo = useCallback((t: Tab) => {
    tabRef.current = t;
    setDot('idle');
    setStatusText('Ready');
    setStatusTab(t);
    setTab(t);
    if (t === 'push') setTimeout(() => loadPushCollectionsRef.current(), 0);
    if (t === 'pull') setTimeout(() => loadPullFilesRef.current(), 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
            setTab('home');
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
        // clear any sub-screen state
        setPushLogs([]);
        setPullLogs([]);
        setPullData(null);
        setPushSelection(null);
        break;
      case 'VARIABLES_DATA':
        variablesResolver.current?.(msg.payload as RawCollection[]);
        variablesResolver.current = null;
        break;
      case 'SET_VARIABLES_RESULT':
        setVarsResolver.current?.(msg.payload as SetVariablesResult);
        setVarsResolver.current = null;
        break;
      case 'HISTORY_DATA':
        setHistory(msg.payload as OperationRecord[]);
        break;
      case 'ERROR': {
        const errMsg = String(msg.payload);
        addPushLog(errMsg, 'error');
        addPullLog(errMsg, 'error');
        setStatus(errMsg, 'error');
        setBusy(false);
        break;
      }
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

  function saveOperation(op: OperationRecord) {
    postMsg({ type: 'SAVE_OPERATION', payload: op });
    setHistory((prev) => [op, ...prev].slice(0, 30));
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

  // ── Push — auto-load collections when tab opens ──
  async function loadPushCollections(preserveSelection = false) {
    if (!settings.token || !settings.owner || !settings.repo || !settings.branch) return;
    setBusy(true);
    try {
      const collections = await getVariables();
      const raw = collectionsToTokenFiles(collections);
      const colMeta = new Map(collections.map((c) => [c.id, { modeCount: c.modes.length, variableCount: c.variables.length }]));
      const tokenFiles: Record<string, { colId: string; fileName: string; content: TokenFile; modeCount: number; variableCount: number }> = {};
      for (const [colId, { fileName, content }] of Object.entries(raw)) {
        const meta = colMeta.get(colId) ?? { modeCount: 1, variableCount: 0 };
        tokenFiles[colId] = { colId, fileName, content, ...meta };
      }
      setPushSelection((prev) => {
        const selected = preserveSelection && prev
          ? new Set(Object.keys(tokenFiles).filter((id) => prev.selected.has(id)))
          : new Set(Object.keys(tokenFiles));
        return { tokenFiles, selected };
      });
    } catch (e) {
      addPushLog(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  loadPushCollectionsRef.current = loadPushCollections;

  // ── Push — push selected collections ──
  async function handlePushSelected() {
    if (!pushSelection) return;
    const selected = Object.values(pushSelection.tokenFiles).filter((f) => pushSelection.selected.has(f.colId));
    if (selected.length === 0) return;
    setBusy(true);
    setPushLogs([]);
    setStatus('Pushing…', 'working');
    const opLines: string[] = [];
    const log = (text: string, kind: LogLine['kind'] = 'info') => { addPushLog(text, kind); opLines.push(text); };
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const created = await provider.ensureBranch(settings.owner, settings.repo, settings.branch);
      if (created) log(`Created branch "${settings.branch}" from default branch`, 'ok');
      for (const { fileName, content } of selected) {
        const filePath = basePath + fileName;
        setStatus(`Pushing ${fileName}…`, 'working');
        log(filePath);
        await provider.putFile(filePath, JSON.stringify(content, null, 2), `chore: sync tokens from Figma (${fileName})`);
        log(`${fileName} pushed`, 'ok');
      }
      log('Done!', 'ok');
      const summary = `Pushed ${selected.length} file(s) to ${settings.branch}`;
      setStatus('Done', 'ok');
      saveOperation({ timestamp: Date.now(), type: 'push', status: 'ok', summary, lines: opLines });
      // Reload the picker so the refresh button stays available; preserve selection
      await loadPushCollections(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(msg, 'error');
      setStatus('Push failed', 'error');
      saveOperation({ timestamp: Date.now(), type: 'push', status: 'error', summary: 'Push failed: ' + msg, lines: opLines });
    } finally {
      setBusy(false);
    }
  }

  // ── Pull ──
  async function loadPullFiles() {
    if (!settings.token || !settings.owner || !settings.repo || !settings.branch) return;
    setBusy(true);
    setPullLogs([]);
    setPullData(null);
    try {
      const provider = buildProvider(settings);
      const basePath = normaliseTokensPath(settings.tokensPath);
      const files = await provider.listFiles(basePath);
      if (files.length === 0) {
        addPullLog('No JSON files found at the tokens path.', 'error');
        return;
      }
      // Download all remote files
      const remoteFiles: Record<string, TokenFile> = {};
      for (const f of files) {
        try {
          const fc = await provider.getFile(f.path);
          if (fc) remoteFiles[f.name] = JSON.parse(fc.content) as TokenFile;
        } catch { /* skip unparseable */ }
      }
      // Diff against current local variables in one pass
      const localCollections = await getVariables();
      const localFiles = Object.values(collectionsToTokenFiles(localCollections))
        .reduce<Record<string, TokenFile>>((acc, { fileName, content }) => { acc[fileName] = content; return acc; }, {});
      const diffs = diffTokenFiles(remoteFiles, localFiles);
      const rows = files
        .filter((f) => remoteFiles[f.name])
        .map((f) => {
          const stats = countTokenFileStats(remoteFiles[f.name]);
          const diff = diffs.find((d) => d.fileName === f.name) ?? { fileName: f.name, added: 0, updated: 0, removed: 0, hasChanges: false, entries: [] };
          return { name: f.name, path: f.path, content: remoteFiles[f.name], ...stats, diff };
        });
      setPullData({ rows, selected: new Set(rows.map((r) => r.name)) });
    } catch (e) {
      addPullLog(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  loadPullFilesRef.current = loadPullFiles;

  async function handleApplySelected() {
    if (!pullData) return;
    const selectedRows = pullData.rows.filter((r) => pullData.selected.has(r.name));
    if (selectedRows.length === 0) return;
    setBusy(true);
    setPullLogs([]);
    setStatus('Applying to Figma…', 'working');
    const opLines: string[] = [];
    const log = (text: string, kind: LogLine['kind'] = 'info') => { addPullLog(text, kind); opLines.push(text); };
    try {
      const remoteFiles = selectedRows.reduce<Record<string, TokenFile>>((acc, r) => { acc[r.name] = r.content; return acc; }, {});
      // Snapshot current state before overwriting — used for revert
      const snapshot = await getVariables();
      const collections = tokenFilesToCollections(remoteFiles);
      const result = await applyVariables(collections);
      result.log.forEach((l) => { log(l, 'ok'); });
      result.errors.forEach((e) => { log(`  ⚠ ${e}`, 'error'); });
      const total = result.created + result.updated;
      log('Done!', 'ok');
      const summary = `Pulled ${selectedRows.length} file(s): ${total} variable(s) across ${collections.length} collection(s)`;
      setStatus('Done', 'ok');
      saveOperation({ timestamp: Date.now(), type: 'pull', status: result.errors.length > 0 ? 'error' : 'ok', summary, lines: opLines, snapshot });
      // Reload so the table reflects the new state
      loadPullFilesRef.current();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(msg, 'error');
      setStatus('Pull failed', 'error');
      saveOperation({ timestamp: Date.now(), type: 'pull', status: 'error', summary: 'Pull failed: ' + msg, lines: opLines });
    } finally {
      setBusy(false);
    }
  }

  async function handleRevert(op: OperationRecord) {
    if (!op.snapshot) return;
    setBusy(true);
    setStatus('Reverting…', 'working');
    try {
      const result = await applyVariables(op.snapshot);
      const d = new Date(op.timestamp);
      const label = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      setStatus('Reverted', 'ok');
      saveOperation({
        timestamp: Date.now(),
        type: 'pull',
        status: result.errors.length > 0 ? 'error' : 'ok',
        summary: `Reverted to snapshot from ${label}`,
        lines: result.log,
      });
    } catch (e) {
      setStatus('Revert failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function saveSettings() {
    postMsg({ type: 'SAVE_SETTINGS', payload: settings });
    setStatus('Settings saved', 'ok');
    if (settings.token && settings.owner && settings.repo && settings.branch) setTab('home');
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
    'https://github.com/settings/tokens/new?scopes=repo&description=Figma+Variable+Sync';
  const patHint =
    settings.provider === 'bitbucket'
      ? <>Enter as <code style={{fontFamily:'monospace',fontSize:10}}>username:app_password</code>. Needs Repositories: Read &amp; Write scope. Stored locally in Figma only.{' '}<a href={patDocsUrl} target="_blank" rel="noreferrer">Create app password ↗</a></>
      : settings.provider === 'gitlab'
      ? <>Needs <code style={{fontFamily:'monospace',fontSize:10}}>api</code> scope. Stored locally in Figma only.{' '}<a href={patDocsUrl} target="_blank" rel="noreferrer">Create one ↗</a></>
      : <>Use a classic token with <code style={{fontFamily:'monospace',fontSize:10}}>repo</code> scope — fine-grained tokens often block writes. Stored locally in Figma only.{' '}<a href={patDocsUrl} target="_blank" rel="noreferrer">Create one ↗</a></>;

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
                  Start syncing
                </button>
              </>
            )}

            <p className="setup-footer">
              Settings are saved locally in Figma — you won't need to reconnect next time.
            </p>
          </section>
        </div>
      )}

      {/* ── Main UI (home + sub-screens) ── */}
      {tab !== 'welcome' && (
        <>
          {/* ── Unified header ── */}
          <div className="app-header">
            <div className="app-header-left">
              {tab === 'home' ? (
                <span className="app-name">Variable Sync</span>
              ) : (
                <button className="back-btn" onClick={() => navigateTo('home')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 12H5M12 5l-7 7 7 7"/>
                  </svg>
                  Home
                </button>
              )}
            </div>
            <div className="app-header-center">
              {tab !== 'home' && (
                <span className="screen-title">
                  {tab === 'push' && 'Push tokens'}
                  {tab === 'pull' && 'Pull tokens'}
                  {tab === 'log' && 'History'}
                  {tab === 'settings' && 'Settings'}
                </span>
              )}
            </div>
            <div className="app-header-right">
              <div className={`dot ${dot}`} />
            </div>
          </div>

          {/* ── Home screen ── */}
          {tab === 'home' && (
            <div className="home-screen">
              <button className="nav-card nav-card--push" onClick={() => navigateTo('push')}>
                <div className="nav-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7"/>
                  </svg>
                </div>
                <div className="nav-card-text">
                  <div className="nav-card-title">Push tokens</div>
                  <div className="nav-card-sub">Export Figma variables to your repo as JSON</div>
                </div>
                <span className="nav-card-arrow">›</span>
              </button>

              <button className="nav-card nav-card--pull" onClick={() => navigateTo('pull')}>
                <div className="nav-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12l7 7 7-7"/>
                  </svg>
                </div>
                <div className="nav-card-text">
                  <div className="nav-card-title">Pull tokens</div>
                  <div className="nav-card-sub">Import token JSON from your repo into Figma</div>
                </div>
                <span className="nav-card-arrow">›</span>
              </button>

              <button className="nav-card nav-card--log" onClick={() => navigateTo('log')}>
                <div className="nav-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <div className="nav-card-text">
                  <div className="nav-card-title">History{history.length > 0 ? ` (${history.length})` : ''}</div>
                  <div className="nav-card-sub">View past push and pull operations</div>
                </div>
                <span className="nav-card-arrow">›</span>
              </button>

              <button className="nav-card nav-card--settings" onClick={() => navigateTo('settings')}>
                <div className="nav-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </div>
                <div className="nav-card-text">
                  <div className="nav-card-title">Settings</div>
                  <div className="nav-card-sub">Manage your repo connection and token path</div>
                </div>
                <span className="nav-card-arrow">›</span>
              </button>

              <button className="nav-card nav-card--info" onClick={() => postMsg({ type: 'OPEN_URL', payload: 'https://github.com/louriach/Figma-Github-token-sync/tree/main/examples' })}>
                <div className="nav-card-icon" style={{ background: 'rgba(255,255,255,.08)', color: '#999' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
                  </svg>
                </div>
                <div className="nav-card-text">
                  <div className="nav-card-title" style={{ color: '#ccc' }}>New here?</div>
                  <div className="nav-card-sub">Browse example token files to get started</div>
                </div>
              </button>
            </div>
          )}

          {/* ── Push screen ── */}
          {tab === 'push' && (
            <div className="panel page--push">
              {!isConnected && (
                <div className="notice">Connect your repository in <strong>Settings</strong> before syncing.</div>
              )}
              <div className="page-card">
                <p className="sync-title">Push tokens to repo</p>
                <p className="sync-desc">Export Figma variable collections to your repo as W3C design token JSON files.</p>
                {busy && !pushSelection && (
                  <p style={{ fontSize: 12, color: '#aaa', marginTop: 16 }}>Reading collections…</p>
                )}
                {pushSelection && (
                  <div style={{ marginTop: 16 }}>
                    <div className="pull-table">
                      <div className="pull-table-head" style={{ gridTemplateColumns: '16px 1fr 48px 48px' }}>
                        <span></span>
                        <span>File</span>
                        <span>Variables</span>
                        <span>Modes</span>
                      </div>
                      {Object.values(pushSelection.tokenFiles).map((f) => (
                        <label key={f.colId} className="pull-table-row" style={{ gridTemplateColumns: '16px 1fr 48px 48px' }}>
                          <input
                            type="checkbox"
                            checked={pushSelection.selected.has(f.colId)}
                            onChange={(e) => {
                              const next = new Set(pushSelection.selected);
                              if (e.target.checked) next.add(f.colId);
                              else next.delete(f.colId);
                              setPushSelection({ ...pushSelection, selected: next });
                            }}
                          />
                          <span className="pull-table-name">{f.fileName}</span>
                          <span className="pull-table-stat">{f.variableCount}</span>
                          <span className="pull-table-stat">{f.modeCount}</span>
                        </label>
                      ))}
                    </div>
                    <div className="btn-row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => loadPushCollections(true)}>Refresh</button>
                      <button className="btn btn-page" disabled={busy || pushSelection.selected.size === 0} onClick={handlePushSelected}>
                        {busy ? 'Pushing…' : 'Push collections'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {dot !== 'idle' && statusTab === 'push' && (
                <div className={`inline-status${dot === 'ok' ? ' inline-status--ok' : dot === 'error' ? ' inline-status--error' : ' inline-status--working'}`}>
                  <div className={`dot ${dot}`} />
                  {statusText}
                </div>
              )}
              {pushLogs.length > 0 && (
                <div className="log-area" ref={pushLogRef}>
                  {pushLogs.map((l, i) => (
                    <div key={i} className={l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : ''}>{l.text}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Pull screen ── */}
          {tab === 'pull' && (
            <div className="panel page--pull">
              {!isConnected && (
                <div className="notice">Connect your repository in <strong>Settings</strong> before syncing.</div>
              )}
              <div className="page-card" style={!pullData && !busy ? { paddingBottom: 0 } : undefined}>
                <p className="sync-title">Pull tokens from repo</p>
                <p className="sync-desc" style={!pullData && !busy ? { marginBottom: 0 } : undefined}>Import W3C design token JSON files from your repo and create or update Figma variables.</p>
                {busy && !pullData && (
                  <p style={{ fontSize: 12, color: '#aaa', marginTop: 16 }}>Loading…</p>
                )}
                {pullData && (
                  <div style={{ marginTop: 16 }}>
                    <div className="pull-table">
                      <div className="pull-table-head">
                        <span></span>
                        <span>File</span>
                        <span>Variables</span>
                        <span>Modes</span>
                        <span>Diff</span>
                      </div>
                      {pullData.rows.map((row) => {
                        const hasChanges = row.diff.hasChanges;
                        const totalChanges = row.diff.added + row.diff.updated + row.diff.removed;
                        return (
                          <label key={row.name} className="pull-table-row">
                            <input
                              type="checkbox"
                              checked={pullData.selected.has(row.name)}
                              onChange={(e) => {
                                const next = new Set(pullData.selected);
                                if (e.target.checked) next.add(row.name);
                                else next.delete(row.name);
                                setPullData({ ...pullData, selected: next });
                              }}
                            />
                            <span className="pull-table-name">{row.name}</span>
                            <span className="pull-table-stat">{row.variables}</span>
                            <span className="pull-table-stat">{row.modes}</span>
                            <span className="pull-table-changes">
                              {hasChanges ? (
                                <button
                                  className="pull-changes-btn"
                                  onClick={(e) => { e.preventDefault(); setDiffDetail(row.name); }}
                                >
                                  {row.diff.added > 0 && <span className="diff-added">+{row.diff.added}</span>}
                                  {row.diff.updated > 0 && <span className="diff-updated">~{row.diff.updated}</span>}
                                  {row.diff.removed > 0 && <span className="diff-removed">−{row.diff.removed}</span>}
                                </button>
                              ) : (
                                <span className="pull-uptodate">✓</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="btn-row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                      <button className="btn btn-ghost" disabled={busy} onClick={loadPullFiles}>Refresh</button>
                      <button className="btn btn-page" disabled={busy || pullData.selected.size === 0} onClick={handleApplySelected}>
                        {busy ? 'Updating…' : 'Update local variables'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {dot !== 'idle' && statusTab === 'pull' && !pullData && (
                <div className={`inline-status${dot === 'ok' ? ' inline-status--ok' : dot === 'error' ? ' inline-status--error' : ' inline-status--working'}`}>
                  <div className={`dot ${dot}`} />
                  {statusText}
                </div>
              )}
              {pullLogs.length > 0 && (
                <div className="log-area" ref={pullLogRef}>
                  {pullLogs.map((l, i) => (
                    <div key={i} className={l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : ''}>{l.text}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Log screen ── */}
          {tab === 'log' && (
            <div className="panel page--log">
              <div className="page-card">
                <p className="sync-title">Operation history</p>
                <p className="sync-desc">Each pull is snapshotted before applying. Expand any entry and use Revert to restore variables to that state.</p>
              {history.length === 0 ? (
                <p style={{ fontSize: 12, color: '#aaa', textAlign: 'center', paddingTop: 8 }}>No operations recorded yet.</p>
              ) : (
                <>
                  {history.map((op, i) => {
                    const d = new Date(op.timestamp);
                    const label = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                    const isOpen = expandedLog === i;
                    return (
                      <div key={i} className="log-entry">
                        <button
                          className="log-entry-header"
                          onClick={() => setExpandedLog(isOpen ? null : i)}
                        >
                          <span className={`log-entry-badge ${op.status === 'ok' ? 'log-badge-ok' : 'log-badge-err'}`}>
                            {op.status === 'ok' ? (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
                              </svg>
                            ) : (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
                                <path d="M12 9v4"/><path d="M12 17h.01"/>
                              </svg>
                            )}
                            {op.type === 'push' ? 'Push' : 'Pull'}
                          </span>
                          <span className="log-entry-summary">{op.summary}</span>
                          <span className="log-entry-time">{label}</span>
                          <svg className="log-entry-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {isOpen ? <path d="m18 15-6-6-6 6"/> : <path d="m6 9 6 6 6-6"/>}
                          </svg>
                        </button>
                        {isOpen && (
                          <div className="log-entry-lines">
                            {op.lines.map((line, j) => (
                              <div key={j} className="log-entry-line">{line}</div>
                            ))}
                            {op.type === 'pull' && op.snapshot && (
                              <div className="log-entry-revert">
                                <button
                                  className="btn-revert"
                                  onClick={() => handleRevert(op)}
                                  disabled={busy}
                                >
                                  Revert to this state
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
              </div>{/* end page-card */}
            </div>
          )}

          {/* ── Settings screen ── */}
          {tab === 'settings' && (
            <div className="panel page--settings">
              <div className="page-card">
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
                    <button className="btn btn-page" onClick={saveSettings}>Save settings</button>
                  </div>
                </>
              )}

              <p className="persist-note" style={{ textAlign: 'left' }}>Settings are saved locally in Figma — you won't need to reconnect next time.</p>
              </div>{/* end page-card */}

              <div className="page-card page-card--danger">
                <p className="sync-title" style={{ color: '#f87171' }}>Reset all saved data</p>
                <p className="sync-desc">Clears your token, repository, branch, and all history from Figma's local storage. This cannot be undone.</p>
                <button className="btn btn-danger" onClick={handleReset}>Reset everything</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Bottom sheet — per-file token detail only ── */}
      {pullData && diffDetail && (() => {
        const d = pullData.rows.find((r) => r.name === diffDetail)?.diff;
        if (!d) return null;
        return (
          <>
            <div className="sheet-scrim" onClick={() => { if (!busy) setDiffDetail(null); }} />
            <div className="sheet">
              <div className="sheet-header">
                <span className="sheet-title">{d.fileName}</span>
                <span className="diff-stats">
                  {d.updated > 0 && <span className="diff-updated">{d.updated} {d.updated === 1 ? 'change' : 'changes'}</span>}
                  {d.added > 0 && <span className="diff-added">+{d.added}</span>}
                  {d.removed > 0 && <span className="diff-removed">−{d.removed}</span>}
                </span>
              </div>
              <div className="sheet-body">
                <div className="diff-entries">
                  {d.entries.map((e, i) => (
                    <div key={i} className={`diff-entry diff-entry--${e.kind}`}>
                      <span className="diff-entry-kind">
                        {e.kind === 'added' ? '+' : e.kind === 'removed' ? '−' : '~'}
                      </span>
                      <span className="diff-entry-path">{e.path}</span>
                      <span className="diff-entry-value">
                        {e.kind === 'updated' && <><span className="diff-entry-old">{String(e.oldValue)}</span><span className="diff-entry-arrow"> → </span><span className="diff-entry-new">{String(e.newValue)}</span></>}
                        {e.kind === 'added' && <span className="diff-entry-new">{String(e.newValue)}</span>}
                        {e.kind === 'removed' && <span className="diff-entry-old">{String(e.oldValue)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="sheet-footer">
                <button className="btn btn-quiet" onClick={() => setDiffDetail(null)} disabled={busy}>Close</button>
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

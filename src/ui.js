"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.default = App;
const react_1 = __importStar(require("react"));
const client_1 = require("react-dom/client");
const types_1 = require("./types");
const github_1 = require("./lib/github");
const gitlab_1 = require("./lib/gitlab");
const bitbucket_1 = require("./lib/bitbucket");
const tokens_1 = require("./lib/tokens");
// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildProvider(s) {
    if (s.provider === 'gitlab')
        return new gitlab_1.GitLabProvider(s.token, s.owner, s.repo, s.branch);
    if (s.provider === 'bitbucket')
        return new bitbucket_1.BitbucketProvider(s.token, s.owner, s.repo, s.branch);
    return new github_1.GitHubProvider(s.token, s.owner, s.repo, s.branch);
}
function normaliseTokensPath(p) {
    return p.endsWith('/') ? p : p + '/';
}
function splitFullName(fullName) {
    const [owner, ...rest] = fullName.split('/');
    return { owner, repo: rest.join('/') };
}
// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
    const [tab, setTab] = (0, react_1.useState)('welcome');
    const [settings, setSettings] = (0, react_1.useState)(types_1.DEFAULT_SETTINGS);
    const [dot, setDot] = (0, react_1.useState)('idle');
    const [statusText, setStatusText] = (0, react_1.useState)('Ready');
    const [logs, setLogs] = (0, react_1.useState)([]);
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [pendingPull, setPendingPull] = (0, react_1.useState)(null);
    const logRef = (0, react_1.useRef)(null);
    const [resetSuccess, setResetSuccess] = (0, react_1.useState)(false);
    const [patValue, setPatValue] = (0, react_1.useState)('');
    const [patValidating, setPatValidating] = (0, react_1.useState)(false);
    const [repos, setRepos] = (0, react_1.useState)([]);
    const [reposLoading, setReposLoading] = (0, react_1.useState)(false);
    const [branches, setBranches] = (0, react_1.useState)([]);
    const [branchesLoading, setBranchesLoading] = (0, react_1.useState)(false);
    const [repoFullName, setRepoFullName] = (0, react_1.useState)('');
    const setupRef = (0, react_1.useRef)(null);
    // ── Communication with code.ts ──
    const postMsg = (0, react_1.useCallback)((msg) => {
        parent.postMessage({ pluginMessage: msg }, '*');
    }, []);
    (0, react_1.useEffect)(() => {
        postMsg({ type: 'GET_SETTINGS' });
        const handler = (event) => {
            var _a;
            const msg = (_a = event.data) === null || _a === void 0 ? void 0 : _a.pluginMessage;
            if (!msg)
                return;
            handlePluginMessage(msg);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    (0, react_1.useEffect)(() => {
        if (logRef.current)
            logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [logs]);
    const addLog = (0, react_1.useCallback)((text, kind = 'info') => {
        setLogs((prev) => [...prev, { text, kind }]);
    }, []);
    const setStatus = (0, react_1.useCallback)((text, state) => {
        setStatusText(text);
        setDot(state);
    }, []);
    const variablesResolver = (0, react_1.useRef)(null);
    const setVarsResolver = (0, react_1.useRef)(null);
    function handlePluginMessage(msg) {
        var _a, _b;
        switch (msg.type) {
            case 'SETTINGS_DATA':
                if (msg.payload) {
                    const s = msg.payload;
                    setSettings(s);
                    if (s.owner && s.repo)
                        setRepoFullName(`${s.owner}/${s.repo}`);
                    if (s.token && s.owner && s.repo && s.branch) {
                        setTab('sync');
                    }
                    else if (s.token) {
                        setTab('settings');
                    }
                }
                break;
            case 'RESET_COMPLETE':
                setSettings(types_1.DEFAULT_SETTINGS);
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
                (_a = variablesResolver.current) === null || _a === void 0 ? void 0 : _a.call(variablesResolver, msg.payload);
                variablesResolver.current = null;
                break;
            case 'SET_VARIABLES_RESULT':
                (_b = setVarsResolver.current) === null || _b === void 0 ? void 0 : _b.call(setVarsResolver, msg.payload);
                setVarsResolver.current = null;
                break;
            case 'ERROR':
                addLog(String(msg.payload), 'error');
                setStatus(String(msg.payload), 'error');
                setBusy(false);
                break;
        }
    }
    function getVariables() {
        return new Promise((resolve) => {
            variablesResolver.current = resolve;
            postMsg({ type: 'GET_VARIABLES' });
        });
    }
    function applyVariables(collections) {
        return new Promise((resolve) => {
            setVarsResolver.current = resolve;
            postMsg({ type: 'SET_VARIABLES', payload: collections });
        });
    }
    function scrollToSetup() {
        var _a;
        (_a = setupRef.current) === null || _a === void 0 ? void 0 : _a.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // ── Connect with PAT ──
    function handleConnect() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!patValue)
                return;
            setPatValidating(true);
            try {
                const provider = settings.provider === 'gitlab' ? new gitlab_1.GitLabProvider(patValue, '', '', '') :
                    settings.provider === 'bitbucket' ? new bitbucket_1.BitbucketProvider(patValue, '', '', '') :
                        new github_1.GitHubProvider(patValue, '', '', '');
                const { login } = yield provider.validateToken();
                const updated = Object.assign(Object.assign({}, settings), { token: patValue, connectedLogin: login });
                setSettings(updated);
                postMsg({ type: 'SAVE_SETTINGS', payload: updated });
                setStatus(`Connected as ${login}`, 'ok');
                yield loadRepos(patValue);
            }
            catch (e) {
                setStatus(e instanceof Error ? e.message : 'Token rejected', 'error');
            }
            finally {
                setPatValidating(false);
            }
        });
    }
    function handleDisconnect() {
        const updated = Object.assign(Object.assign({}, types_1.DEFAULT_SETTINGS), { provider: settings.provider });
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
    function loadRepos(token) {
        return __awaiter(this, void 0, void 0, function* () {
            setReposLoading(true);
            try {
                const p = settings.provider === 'gitlab' ? new gitlab_1.GitLabProvider(token, '', '', '') :
                    settings.provider === 'bitbucket' ? new bitbucket_1.BitbucketProvider(token, '', '', '') :
                        new github_1.GitHubProvider(token, '', '', '');
                setRepos(yield p.listRepos());
            }
            catch ( /* ignore */_a) { /* ignore */ }
            finally {
                setReposLoading(false);
            }
        });
    }
    function handleRepoChange(fullName) {
        return __awaiter(this, void 0, void 0, function* () {
            setRepoFullName(fullName);
            const { owner, repo } = splitFullName(fullName);
            setSettings((prev) => (Object.assign(Object.assign({}, prev), { owner, repo, branch: '' })));
            setBranches([]);
            if (!owner || !repo)
                return;
            setBranchesLoading(true);
            try {
                const p = settings.provider === 'gitlab' ? new gitlab_1.GitLabProvider(settings.token, owner, repo, '') :
                    settings.provider === 'bitbucket' ? new bitbucket_1.BitbucketProvider(settings.token, owner, repo, '') :
                        new github_1.GitHubProvider(settings.token, owner, repo, '');
                const list = yield p.listBranches(owner, repo);
                setBranches(list);
                if (list.length > 0)
                    setSettings((prev) => (Object.assign(Object.assign({}, prev), { branch: list[0] })));
            }
            catch ( /* ignore */_a) { /* ignore */ }
            finally {
                setBranchesLoading(false);
            }
        });
    }
    // ── Push ──
    function handlePush() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!validateSettings())
                return;
            setBusy(true);
            setLogs([]);
            setStatus('Reading Figma variables…', 'working');
            try {
                const provider = buildProvider(settings);
                const basePath = normaliseTokensPath(settings.tokensPath);
                const created = yield provider.ensureBranch(settings.owner, settings.repo, settings.branch);
                if (created)
                    addLog(`Created branch "${settings.branch}" from default branch`, 'ok');
                const collections = yield getVariables();
                addLog(`Found ${collections.length} collection(s)`);
                const tokenFiles = (0, tokens_1.collectionsToTokenFiles)(collections);
                for (const { fileName, content } of Object.values(tokenFiles)) {
                    const filePath = basePath + fileName;
                    setStatus(`Pushing ${fileName}…`, 'working');
                    addLog(`→ ${filePath}`);
                    const existing = yield provider.getFile(filePath);
                    yield provider.putFile(filePath, JSON.stringify(content, null, 2), `chore: sync tokens from Figma (${fileName})`, existing === null || existing === void 0 ? void 0 : existing.sha);
                    addLog(`✓ ${fileName} pushed`, 'ok');
                }
                setStatus(`Pushed ${Object.keys(tokenFiles).length} file(s)`, 'ok');
                addLog('Done!', 'ok');
            }
            catch (e) {
                addLog(e instanceof Error ? e.message : String(e), 'error');
                setStatus('Push failed', 'error');
            }
            finally {
                setBusy(false);
            }
        });
    }
    // ── Pull ──
    function handlePull() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!validateSettings())
                return;
            setBusy(true);
            setLogs([]);
            setPendingPull(null);
            setStatus('Listing token files…', 'working');
            try {
                const provider = buildProvider(settings);
                const basePath = normaliseTokensPath(settings.tokensPath);
                const files = yield provider.listFiles(basePath);
                if (files.length === 0) {
                    addLog('No JSON files found at the tokens path.', 'error');
                    setStatus('No files found', 'error');
                    setBusy(false);
                    return;
                }
                addLog(`Found ${files.length} file(s)`);
                const remoteFiles = {};
                for (const f of files) {
                    setStatus(`Downloading ${f.name}…`, 'working');
                    addLog(`← ${f.path}`);
                    const fc = yield provider.getFile(f.path);
                    if (!fc) {
                        addLog(`  ✗ ${f.name} not found — skipped`, 'error');
                        continue;
                    }
                    try {
                        remoteFiles[f.name] = JSON.parse(fc.content);
                        addLog(`✓ ${f.name} downloaded`, 'ok');
                    }
                    catch (_a) {
                        addLog(`  ✗ ${f.name} is not valid JSON — skipped`, 'error');
                    }
                }
                if (Object.keys(remoteFiles).length === 0) {
                    setStatus('No valid files found', 'error');
                    setBusy(false);
                    return;
                }
                setStatus('Comparing with local variables…', 'working');
                const localCollections = yield getVariables();
                const localFiles = Object.values((0, tokens_1.collectionsToTokenFiles)(localCollections))
                    .reduce((acc, { fileName, content }) => {
                    acc[fileName] = content;
                    return acc;
                }, {});
                const diffs = (0, tokens_1.diffTokenFiles)(remoteFiles, localFiles);
                setPendingPull({ files: remoteFiles, diffs });
                setStatus('Review changes before applying', 'idle');
            }
            catch (e) {
                addLog(e instanceof Error ? e.message : String(e), 'error');
                setStatus('Pull failed', 'error');
            }
            finally {
                setBusy(false);
            }
        });
    }
    function handleConfirmPull() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!pendingPull)
                return;
            setBusy(true);
            setStatus('Applying to Figma…', 'working');
            try {
                const collections = (0, tokens_1.tokenFilesToCollections)(pendingPull.files);
                const result = yield applyVariables(collections);
                addLog(`Created ${result.created} variable(s), updated ${result.updated}`, 'ok');
                result.errors.forEach((e) => addLog(`  ⚠ ${e}`, 'error'));
                setStatus(`Applied ${result.created + result.updated} variable(s)`, 'ok');
                addLog('Done!', 'ok');
                setPendingPull(null);
            }
            catch (e) {
                addLog(e instanceof Error ? e.message : String(e), 'error');
                setStatus('Pull failed', 'error');
            }
            finally {
                setBusy(false);
            }
        });
    }
    function validateSettings() {
        const problems = [
            !settings.token && 'Not connected — add your token in Settings',
            !settings.owner && 'No repository selected',
            !settings.repo && 'No repository selected',
            !settings.branch && 'No branch selected',
        ].filter(Boolean);
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
        if (settings.token && settings.owner && settings.repo && settings.branch)
            setTab('sync');
    }
    const isConnected = !!settings.token && !!settings.connectedLogin;
    const providerLabel = settings.provider === 'gitlab' ? 'GitLab' :
        settings.provider === 'bitbucket' ? 'Bitbucket' : 'GitHub';
    const patPlaceholder = settings.provider === 'gitlab' ? 'glpat-…' :
        settings.provider === 'bitbucket' ? 'username:app_password' :
            'github_pat_…';
    const patDocsUrl = settings.provider === 'gitlab' ? 'https://gitlab.com/-/user_settings/personal_access_tokens' :
        settings.provider === 'bitbucket' ? 'https://bitbucket.org/account/settings/app-passwords' :
            'https://github.com/settings/personal-access-tokens/new';
    const patHint = settings.provider === 'bitbucket'
        ? react_1.default.createElement(react_1.default.Fragment, null,
            "Enter as ",
            react_1.default.createElement("code", { style: { fontFamily: 'monospace', fontSize: 10 } }, "username:app_password"),
            ". Needs Repositories: Read & Write scope. Stored locally in Figma only.",
            ' ',
            react_1.default.createElement("a", { href: patDocsUrl, target: "_blank", rel: "noreferrer" }, "Create app password \u2197"))
        : react_1.default.createElement(react_1.default.Fragment, null,
            "Needs Contents: Read & Write scope. Stored locally in Figma only.",
            ' ',
            react_1.default.createElement("a", { href: patDocsUrl, target: "_blank", rel: "noreferrer" }, "Create one \u2197"));
    // ─── Render ────────────────────────────────────────────────────────────────
    return (react_1.default.createElement(react_1.default.Fragment, null,
        tab === 'welcome' && (react_1.default.createElement("div", { className: "welcome-page" },
            react_1.default.createElement("section", { className: "welcome-hero" },
                resetSuccess && (react_1.default.createElement("div", { className: "welcome-reset-banner" }, "All saved data cleared.")),
                react_1.default.createElement("div", { className: "welcome-eyebrow" }, "Variable Sync to Repo"),
                react_1.default.createElement("div", { className: "welcome-visual" },
                    react_1.default.createElement("div", { className: "welcome-video" },
                        react_1.default.createElement("div", { className: "welcome-play" })),
                    react_1.default.createElement("span", { className: "welcome-video-label" }, "Video walkthrough \u00B7 coming soon")),
                react_1.default.createElement("div", { className: "welcome-text" },
                    react_1.default.createElement("p", { className: "welcome-lead" }, "Sync Figma variables to"),
                    react_1.default.createElement("div", { className: "provider-pills" },
                        react_1.default.createElement("span", { className: "provider-pill" },
                            react_1.default.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor" },
                                react_1.default.createElement("path", { d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" })),
                            "GitHub"),
                        react_1.default.createElement("span", { className: "provider-pill" },
                            react_1.default.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor" },
                                react_1.default.createElement("path", { d: "M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.45.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.444a.92.92 0 00.33-1.023" })),
                            "GitLab"),
                        react_1.default.createElement("span", { className: "provider-pill" },
                            react_1.default.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor" },
                                react_1.default.createElement("path", { d: "M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" })),
                            "Bitbucket")),
                    react_1.default.createElement("p", { className: "welcome-desc" }, "Push variables from Figma to your repo, or pull them back \u2014 all as W3C design tokens, with no manual copying.")),
                react_1.default.createElement("div", { className: "welcome-cta" },
                    react_1.default.createElement("button", { className: "btn btn-primary btn-full", onClick: scrollToSetup }, "Get started"),
                    react_1.default.createElement("p", { className: "welcome-security" }, "Your variables are stored locally in Figma only, never on our servers."))),
            react_1.default.createElement("section", { className: "welcome-setup", ref: setupRef },
                react_1.default.createElement("div", { className: "setup-header" },
                    react_1.default.createElement("h2", { className: "setup-title" }, "Connect your account"),
                    react_1.default.createElement("p", { className: "setup-sub" }, isConnected
                        ? 'Now choose a repository and branch to sync with.'
                        : 'Paste a personal access token to authenticate with your provider.')),
                react_1.default.createElement("div", { className: "field" },
                    react_1.default.createElement("label", null, "Git Provider"),
                    react_1.default.createElement("select", { value: settings.provider, onChange: (e) => {
                            setSettings((prev) => (Object.assign(Object.assign({}, prev), { provider: e.target.value })));
                            setRepos([]);
                            setBranches([]);
                        } },
                        react_1.default.createElement("option", { value: "github" }, "GitHub"),
                        react_1.default.createElement("option", { value: "gitlab" }, "GitLab"),
                        react_1.default.createElement("option", { value: "bitbucket" }, "Bitbucket"))),
                react_1.default.createElement("div", { className: "setup-divider" }),
                isConnected ? (react_1.default.createElement("div", { className: "connected-card" },
                    react_1.default.createElement("div", { className: "connected-avatar" }, settings.connectedLogin.charAt(0).toUpperCase()),
                    react_1.default.createElement("div", { className: "connected-info" },
                        react_1.default.createElement("div", { className: "connected-name" },
                            "@",
                            settings.connectedLogin),
                        react_1.default.createElement("div", { className: "connected-sub" },
                            "Connected to ",
                            providerLabel)),
                    react_1.default.createElement("button", { className: "btn-danger-ghost", onClick: handleDisconnect }, "Disconnect"))) : (react_1.default.createElement("div", { className: "field" },
                    react_1.default.createElement("label", null, "Personal Access Token"),
                    react_1.default.createElement("div", { className: "input-row" },
                        react_1.default.createElement("input", { type: "password", placeholder: patPlaceholder, value: patValue, onChange: (e) => setPatValue(e.target.value), onKeyDown: (e) => e.key === 'Enter' && handleConnect() }),
                        react_1.default.createElement("button", { className: "btn btn-primary btn-inline", onClick: handleConnect, disabled: !patValue || patValidating }, patValidating ? '…' : 'Connect')),
                    react_1.default.createElement("div", { className: "hint" }, patHint))),
                isConnected && (react_1.default.createElement(react_1.default.Fragment, null,
                    react_1.default.createElement("div", { className: "setup-divider" }),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null,
                            "Repository ",
                            reposLoading && react_1.default.createElement("span", { className: "loading-label" }, "Loading\u2026")),
                        repos.length > 0 ? (react_1.default.createElement("select", { value: repoFullName, onChange: (e) => handleRepoChange(e.target.value) },
                            react_1.default.createElement("option", { value: "" }, "\u2014 select a repository \u2014"),
                            repos.map((r) => react_1.default.createElement("option", { key: r, value: r }, r)))) : (react_1.default.createElement("input", { type: "text", placeholder: "owner/repo-name", value: repoFullName, onChange: (e) => handleRepoChange(e.target.value) }))),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null,
                            "Branch ",
                            branchesLoading && react_1.default.createElement("span", { className: "loading-label" }, "Loading\u2026")),
                        react_1.default.createElement("input", { list: "branch-datalist", placeholder: "main", value: settings.branch, onChange: (e) => setSettings((prev) => (Object.assign(Object.assign({}, prev), { branch: e.target.value }))) }),
                        react_1.default.createElement("datalist", { id: "branch-datalist" }, branches.map((b) => react_1.default.createElement("option", { key: b, value: b }))),
                        settings.branch && !branches.includes(settings.branch) && branches.length > 0 && (react_1.default.createElement("div", { className: "hint ok" },
                            "\u2713 \"",
                            settings.branch,
                            "\" will be created on first push"))),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null, "Tokens path"),
                        react_1.default.createElement("input", { type: "text", placeholder: "tokens/", value: settings.tokensPath, onChange: (e) => setSettings((prev) => (Object.assign(Object.assign({}, prev), { tokensPath: e.target.value }))) }),
                        react_1.default.createElement("div", { className: "hint" }, "Directory in your repo where token JSON files are stored.")),
                    react_1.default.createElement("button", { className: "btn btn-primary btn-full", style: { marginTop: 20 }, onClick: saveSettings }, "Start syncing \u2192"))),
                react_1.default.createElement("p", { className: "setup-footer" }, "Settings are saved locally in Figma \u2014 you won't need to reconnect next time.")))),
        tab !== 'welcome' && (react_1.default.createElement(react_1.default.Fragment, null,
            react_1.default.createElement("div", { className: "status-bar" },
                react_1.default.createElement("div", { className: `dot ${dot}` }),
                react_1.default.createElement("span", { className: "status-text" }, statusText)),
            react_1.default.createElement("div", { className: "tabs" },
                react_1.default.createElement("button", { className: `tab${tab === 'sync' ? ' active' : ''}`, onClick: () => setTab('sync') }, "Sync"),
                react_1.default.createElement("button", { className: `tab${tab === 'settings' ? ' active' : ''}`, onClick: () => setTab('settings') }, "Settings")),
            tab === 'sync' && (react_1.default.createElement("div", { className: "panel" },
                !isConnected && (react_1.default.createElement("div", { className: "notice" },
                    "Connect your repository in ",
                    react_1.default.createElement("strong", null, "Settings"),
                    " before syncing.")),
                react_1.default.createElement("div", { className: "sync-card" },
                    react_1.default.createElement("h3", null,
                        "\u2191 Push to ",
                        providerLabel),
                    react_1.default.createElement("p", null, "Export all Figma variable collections as W3C design token JSON files."),
                    react_1.default.createElement("button", { className: "btn btn-primary", disabled: busy, onClick: handlePush }, busy ? 'Working…' : 'Push tokens')),
                react_1.default.createElement("div", { className: "sync-card" },
                    react_1.default.createElement("h3", null,
                        "\u2193 Pull from ",
                        providerLabel),
                    react_1.default.createElement("p", null, "Import W3C design token JSON files and create/update Figma variables."),
                    react_1.default.createElement("button", { className: "btn btn-secondary", disabled: busy, onClick: handlePull }, busy ? 'Working…' : 'Pull tokens')),
                pendingPull && (react_1.default.createElement("div", { className: "diff-panel" },
                    react_1.default.createElement("div", { className: "diff-header" }, "Changes from remote"),
                    pendingPull.diffs.map((d) => (react_1.default.createElement("div", { key: d.fileName, className: "diff-file-row" },
                        react_1.default.createElement("span", { className: "diff-file-name" }, d.fileName),
                        react_1.default.createElement("span", { className: "diff-stats" },
                            !d.hasChanges && react_1.default.createElement("span", { className: "diff-none" }, "no changes"),
                            d.updated > 0 && react_1.default.createElement("span", { className: "diff-updated" },
                                d.updated,
                                " updated"),
                            d.added > 0 && react_1.default.createElement("span", { className: "diff-added" },
                                "+",
                                d.added,
                                " added"),
                            d.removed > 0 && react_1.default.createElement("span", { className: "diff-removed" },
                                "\u2212",
                                d.removed,
                                " removed"))))),
                    react_1.default.createElement("p", { className: "diff-hint" }, "Before applying, save a version in Figma (Menu \u2192 Save to version history) as a restore point."),
                    react_1.default.createElement("div", { className: "btn-row" },
                        react_1.default.createElement("button", { className: "btn btn-primary", onClick: handleConfirmPull, disabled: busy }, "Apply changes"),
                        react_1.default.createElement("button", { className: "btn btn-secondary", onClick: () => { setPendingPull(null); setLogs([]); }, disabled: busy }, "Cancel")))),
                !pendingPull && logs.length > 0 && (react_1.default.createElement("div", { className: "log-area", ref: logRef }, logs.map((l, i) => (react_1.default.createElement("div", { key: i, className: l.kind === 'ok' ? 'log-ok' : l.kind === 'error' ? 'log-error' : '' }, l.text))))),
                react_1.default.createElement("p", { className: "persist-note", style: { marginTop: 16 } },
                    "New here?",
                    ' ',
                    react_1.default.createElement("button", { className: "btn-link", onClick: () => postMsg({ type: 'OPEN_URL', payload: 'https://github.com/louriach/Figma-Github-token-sync/tree/main/examples' }) }, "Try the example token files \u2192")))),
            tab === 'settings' && (react_1.default.createElement("div", { className: "panel" },
                react_1.default.createElement("div", { className: "section-title" }, "Provider"),
                react_1.default.createElement("div", { className: "field" },
                    react_1.default.createElement("label", null, "Git Provider"),
                    react_1.default.createElement("select", { value: settings.provider, onChange: (e) => {
                            setSettings((prev) => (Object.assign(Object.assign({}, prev), { provider: e.target.value })));
                            setRepos([]);
                            setBranches([]);
                        } },
                        react_1.default.createElement("option", { value: "github" }, "GitHub"),
                        react_1.default.createElement("option", { value: "gitlab" }, "GitLab"),
                        react_1.default.createElement("option", { value: "bitbucket" }, "Bitbucket"))),
                react_1.default.createElement("hr", { className: "divider" }),
                react_1.default.createElement("div", { className: "section-title" }, "Authentication"),
                isConnected ? (react_1.default.createElement("div", { className: "connected-card" },
                    react_1.default.createElement("div", { className: "connected-avatar" }, settings.connectedLogin.charAt(0).toUpperCase()),
                    react_1.default.createElement("div", { className: "connected-info" },
                        react_1.default.createElement("div", { className: "connected-name" },
                            "@",
                            settings.connectedLogin),
                        react_1.default.createElement("div", { className: "connected-sub" },
                            "Connected to ",
                            providerLabel)),
                    react_1.default.createElement("button", { className: "btn-danger-ghost", onClick: handleDisconnect }, "Disconnect"))) : (react_1.default.createElement("div", { className: "field" },
                    react_1.default.createElement("label", null, "Personal Access Token"),
                    react_1.default.createElement("div", { className: "input-row" },
                        react_1.default.createElement("input", { type: "password", placeholder: patPlaceholder, value: patValue, onChange: (e) => setPatValue(e.target.value), onKeyDown: (e) => e.key === 'Enter' && handleConnect() }),
                        react_1.default.createElement("button", { className: "btn btn-primary btn-inline", onClick: handleConnect, disabled: !patValue || patValidating }, patValidating ? '…' : 'Connect')),
                    react_1.default.createElement("div", { className: "hint" }, patHint))),
                isConnected && (react_1.default.createElement(react_1.default.Fragment, null,
                    react_1.default.createElement("hr", { className: "divider" }),
                    react_1.default.createElement("div", { className: "section-title" }, "Repository"),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null,
                            "Repository ",
                            reposLoading && react_1.default.createElement("span", { className: "loading-label" }, "Loading\u2026")),
                        repos.length > 0 ? (react_1.default.createElement("select", { value: repoFullName, onChange: (e) => handleRepoChange(e.target.value) },
                            react_1.default.createElement("option", { value: "" }, "\u2014 select a repository \u2014"),
                            repos.map((r) => react_1.default.createElement("option", { key: r, value: r }, r)))) : (react_1.default.createElement("input", { type: "text", placeholder: "owner/repo-name", value: repoFullName, onChange: (e) => handleRepoChange(e.target.value) }))),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null,
                            "Branch ",
                            branchesLoading && react_1.default.createElement("span", { className: "loading-label" }, "Loading\u2026")),
                        react_1.default.createElement("input", { list: "branch-datalist", placeholder: "main", value: settings.branch, onChange: (e) => setSettings((prev) => (Object.assign(Object.assign({}, prev), { branch: e.target.value }))) }),
                        react_1.default.createElement("datalist", { id: "branch-datalist" }, branches.map((b) => react_1.default.createElement("option", { key: b, value: b }))),
                        settings.branch && !branches.includes(settings.branch) && branches.length > 0 && (react_1.default.createElement("div", { className: "hint ok" },
                            "\u2713 \"",
                            settings.branch,
                            "\" will be created on first push"))),
                    react_1.default.createElement("div", { className: "field" },
                        react_1.default.createElement("label", null, "Tokens path"),
                        react_1.default.createElement("input", { type: "text", placeholder: "tokens/", value: settings.tokensPath, onChange: (e) => setSettings((prev) => (Object.assign(Object.assign({}, prev), { tokensPath: e.target.value }))) }),
                        react_1.default.createElement("div", { className: "hint" }, "Directory where token JSON files are stored.")),
                    react_1.default.createElement("div", { className: "btn-row" },
                        react_1.default.createElement("button", { className: "btn btn-primary", onClick: saveSettings }, "Save settings")))),
                react_1.default.createElement("div", { className: "persist-note" },
                    "Settings are saved locally in Figma \u2014 you won't need to reconnect next time.",
                    react_1.default.createElement("br", null),
                    react_1.default.createElement("button", { className: "btn-link", onClick: handleReset }, "Reset all saved data"))))))));
}
const root = (0, client_1.createRoot)(document.getElementById('root'));
root.render(react_1.default.createElement(App, null));

"use strict";
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
exports.GitHubProvider = void 0;
function b64Decode(b64) {
    const bytes = Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
function b64Encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
}
class GitHubProvider {
    constructor(token, owner, repo, branch) {
        this.token = token;
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        this.base = 'https://api.github.com';
        this.ownerEnc = encodeURIComponent(owner);
        this.repoEnc = encodeURIComponent(repo);
        this.branchEnc = encodeURIComponent(branch);
    }
    headers() {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }
    validateToken() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield fetch(`${this.base}/user`, { headers: this.headers() });
            if (!res.ok)
                throw new Error(`GitHub auth failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return { login: data.login };
        });
    }
    listRepos() {
        return __awaiter(this, void 0, void 0, function* () {
            const repos = [];
            let page = 1;
            while (true) {
                const res = yield fetch(`${this.base}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`GitHub list repos failed: ${res.status} ${res.statusText}`);
                const data = yield res.json();
                if (data.length === 0)
                    break;
                repos.push(...data.map((r) => r.full_name));
                if (data.length < 100)
                    break;
                page++;
            }
            return repos;
        });
    }
    listBranches(owner, repo) {
        return __awaiter(this, void 0, void 0, function* () {
            const branches = [];
            let page = 1;
            while (true) {
                const res = yield fetch(`${this.base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`GitHub list branches failed: ${res.status} ${res.statusText}`);
                const data = yield res.json();
                if (data.length === 0)
                    break;
                branches.push(...data.map((b) => b.name));
                if (data.length < 100)
                    break;
                page++;
            }
            return branches;
        });
    }
    ensureBranch(owner, repo, branch) {
        return __awaiter(this, void 0, void 0, function* () {
            const oEnc = encodeURIComponent(owner);
            const rEnc = encodeURIComponent(repo);
            // Check if branch already exists
            const checkRes = yield fetch(`${this.base}/repos/${oEnc}/${rEnc}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: this.headers() });
            if (checkRes.ok)
                return false; // already exists
            // Get the default branch to branch from
            const repoRes = yield fetch(`${this.base}/repos/${oEnc}/${rEnc}`, { headers: this.headers() });
            if (!repoRes.ok)
                throw new Error(`Cannot read repo info: ${repoRes.status}`);
            const repoData = yield repoRes.json();
            const defaultBranch = repoData.default_branch;
            // Get the SHA of the default branch HEAD
            const refRes = yield fetch(`${this.base}/repos/${oEnc}/${rEnc}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers: this.headers() });
            if (!refRes.ok)
                throw new Error(`Cannot read default branch ref: ${refRes.status}`);
            const refData = yield refRes.json();
            const sha = refData.object.sha;
            // Create the new branch
            const createRes = yield fetch(`${this.base}/repos/${oEnc}/${rEnc}/git/refs`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
            });
            if (!createRes.ok) {
                const err = yield createRes.json().catch(() => ({ message: createRes.statusText }));
                throw new Error(`GitHub create branch failed: ${createRes.status} – ${err.message}`);
            }
            return true;
        });
    }
    listFiles(dirPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const path = dirPath.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
            const res = yield fetch(`${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${path}?ref=${this.branchEnc}`, { headers: this.headers() });
            if (res.status === 404)
                return [];
            if (!res.ok)
                throw new Error(`GitHub list failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            if (!Array.isArray(data))
                return [];
            return data
                .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
                .map((f) => ({
                name: f.name,
                path: f.path,
                sha: f.sha,
            }));
        });
    }
    getFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
            const res = yield fetch(`${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${encodedPath}?ref=${this.branchEnc}`, { headers: this.headers() });
            if (res.status === 404)
                return null;
            if (!res.ok)
                throw new Error(`GitHub get failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return { content: b64Decode(data.content), sha: data.sha };
        });
    }
    putFile(filePath, content, message, sha) {
        return __awaiter(this, void 0, void 0, function* () {
            const body = {
                message,
                content: b64Encode(content),
                branch: this.branch,
            };
            if (sha)
                body.sha = sha;
            const res = yield fetch(`${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${filePath}`, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
            if (!res.ok) {
                const err = yield res.json().catch(() => ({ message: res.statusText }));
                throw new Error(`GitHub put failed: ${res.status} – ${err.message}`);
            }
        });
    }
}
exports.GitHubProvider = GitHubProvider;

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
exports.GitLabProvider = void 0;
class GitLabProvider {
    constructor(token, owner, repo, branch) {
        this.token = token;
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        this.base = 'https://gitlab.com/api/v4';
        this.projectId = encodeURIComponent(`${owner}/${repo}`);
    }
    headers() {
        return {
            'PRIVATE-TOKEN': this.token,
            'Content-Type': 'application/json',
        };
    }
    validateToken() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield fetch(`${this.base}/user`, { headers: this.headers() });
            if (!res.ok)
                throw new Error(`GitLab auth failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return { login: data.username };
        });
    }
    listRepos() {
        return __awaiter(this, void 0, void 0, function* () {
            const repos = [];
            let page = 1;
            while (true) {
                const res = yield fetch(`${this.base}/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at`, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`GitLab list repos failed: ${res.status} ${res.statusText}`);
                const data = yield res.json();
                if (data.length === 0)
                    break;
                repos.push(...data.map((r) => r.path_with_namespace));
                if (data.length < 100)
                    break;
                page++;
            }
            return repos;
        });
    }
    listBranches(owner, repo) {
        return __awaiter(this, void 0, void 0, function* () {
            const projectId = encodeURIComponent(`${owner}/${repo}`);
            const branches = [];
            let page = 1;
            while (true) {
                const res = yield fetch(`${this.base}/projects/${projectId}/repository/branches?per_page=100&page=${page}`, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`GitLab list branches failed: ${res.status} ${res.statusText}`);
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
            const projectId = encodeURIComponent(`${owner}/${repo}`);
            // Check if branch exists
            const checkRes = yield fetch(`${this.base}/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`, { headers: this.headers() });
            if (checkRes.ok)
                return false;
            // Get default branch
            const projectRes = yield fetch(`${this.base}/projects/${projectId}`, { headers: this.headers() });
            if (!projectRes.ok)
                throw new Error(`Cannot read project info: ${projectRes.status}`);
            const projectData = yield projectRes.json();
            const defaultBranch = projectData.default_branch;
            // Create branch from default
            const createRes = yield fetch(`${this.base}/projects/${projectId}/repository/branches`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ branch, ref: defaultBranch }),
            });
            if (!createRes.ok) {
                const err = yield createRes.json().catch(() => ({ message: createRes.statusText }));
                throw new Error(`GitLab create branch failed: ${createRes.status} – ${err.message}`);
            }
            return true;
        });
    }
    listFiles(dirPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const path = dirPath.replace(/\/$/, '');
            const url = new URL(`${this.base}/projects/${this.projectId}/repository/tree`);
            url.searchParams.set('path', path);
            url.searchParams.set('ref', this.branch);
            url.searchParams.set('per_page', '100');
            const res = yield fetch(url.toString(), { headers: this.headers() });
            if (res.status === 404)
                return [];
            if (!res.ok)
                throw new Error(`GitLab list failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return data
                .filter((f) => f.type === 'blob' && f.name.endsWith('.json'))
                .map((f) => ({ name: f.name, path: f.path, sha: f.id }));
        });
    }
    getFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const encodedPath = encodeURIComponent(filePath);
            const res = yield fetch(`${this.base}/projects/${this.projectId}/repository/files/${encodedPath}?ref=${this.branch}`, { headers: this.headers() });
            if (res.status === 404)
                return null;
            if (!res.ok)
                throw new Error(`GitLab get failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
            return { content: new TextDecoder().decode(bytes), sha: data.content_sha256 };
        });
    }
    putFile(filePath, content, message, _sha) {
        return __awaiter(this, void 0, void 0, function* () {
            const encodedPath = encodeURIComponent(filePath);
            const existingFile = yield this.getFile(filePath);
            const method = existingFile ? 'PUT' : 'POST';
            const res = yield fetch(`${this.base}/projects/${this.projectId}/repository/files/${encodedPath}`, {
                method,
                headers: this.headers(),
                body: JSON.stringify({
                    branch: this.branch,
                    content,
                    commit_message: message,
                    encoding: 'text',
                }),
            });
            if (!res.ok) {
                const err = yield res.json().catch(() => ({ message: res.statusText }));
                throw new Error(`GitLab put failed: ${res.status} – ${err.message}`);
            }
        });
    }
}
exports.GitLabProvider = GitLabProvider;

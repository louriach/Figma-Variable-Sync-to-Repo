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
exports.BitbucketProvider = void 0;
function b64Encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
}
class BitbucketProvider {
    constructor(token, // format: "username:app_password"
    owner, repo, branch) {
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        this.base = 'https://api.bitbucket.org/2.0';
        this.authHeader = `Basic ${b64Encode(token)}`;
        this.ownerEnc = encodeURIComponent(owner);
        this.repoEnc = encodeURIComponent(repo);
        this.branchEnc = encodeURIComponent(branch);
    }
    headers() {
        return {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
        };
    }
    validateToken() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const res = yield fetch(`${this.base}/user`, { headers: this.headers() });
            if (!res.ok)
                throw new Error(`Bitbucket auth failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return { login: (_a = data.nickname) !== null && _a !== void 0 ? _a : data.username };
        });
    }
    listRepos() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const repos = [];
            let url = `${this.base}/repositories?role=member&pagelen=100&sort=-updated_on`;
            while (url) {
                const res = yield fetch(url, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`Bitbucket list repos failed: ${res.status} ${res.statusText}`);
                const data = yield res.json();
                repos.push(...data.values.map((r) => r.full_name));
                url = (_a = data.next) !== null && _a !== void 0 ? _a : null;
            }
            return repos;
        });
    }
    listBranches(owner, repo) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const oEnc = encodeURIComponent(owner);
            const rEnc = encodeURIComponent(repo);
            const branches = [];
            let url = `${this.base}/repositories/${oEnc}/${rEnc}/refs/branches?pagelen=100`;
            while (url) {
                const res = yield fetch(url, { headers: this.headers() });
                if (!res.ok)
                    throw new Error(`Bitbucket list branches failed: ${res.status} ${res.statusText}`);
                const data = yield res.json();
                branches.push(...data.values.map((b) => b.name));
                url = (_a = data.next) !== null && _a !== void 0 ? _a : null;
            }
            return branches;
        });
    }
    ensureBranch(owner, repo, branch) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const oEnc = encodeURIComponent(owner);
            const rEnc = encodeURIComponent(repo);
            const checkRes = yield fetch(`${this.base}/repositories/${oEnc}/${rEnc}/refs/branches/${encodeURIComponent(branch)}`, { headers: this.headers() });
            if (checkRes.ok)
                return false;
            // Get default branch name
            const repoRes = yield fetch(`${this.base}/repositories/${oEnc}/${rEnc}`, { headers: this.headers() });
            if (!repoRes.ok)
                throw new Error(`Cannot read repo info: ${repoRes.status}`);
            const repoData = yield repoRes.json();
            const defaultBranch = repoData.mainbranch.name;
            // Get HEAD commit of default branch
            const branchRes = yield fetch(`${this.base}/repositories/${oEnc}/${rEnc}/refs/branches/${encodeURIComponent(defaultBranch)}`, { headers: this.headers() });
            if (!branchRes.ok)
                throw new Error(`Cannot read default branch: ${branchRes.status}`);
            const branchData = yield branchRes.json();
            const sha = branchData.target.hash;
            const createRes = yield fetch(`${this.base}/repositories/${oEnc}/${rEnc}/refs/branches`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ name: branch, target: { hash: sha } }),
            });
            if (!createRes.ok) {
                const err = yield createRes.json().catch(() => ({ error: { message: createRes.statusText } }));
                throw new Error(`Bitbucket create branch failed: ${createRes.status} – ${(_b = (_a = err === null || err === void 0 ? void 0 : err.error) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : ''}`);
            }
            return true;
        });
    }
    listFiles(dirPath) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const path = dirPath.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
            const res = yield fetch(`${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src/${this.branchEnc}/${path}?pagelen=100`, { headers: this.headers() });
            if (res.status === 404)
                return [];
            if (!res.ok)
                throw new Error(`Bitbucket list failed: ${res.status} ${res.statusText}`);
            const data = yield res.json();
            return ((_a = data.values) !== null && _a !== void 0 ? _a : [])
                .filter((f) => f.type === 'commit_file' && f.path.endsWith('.json'))
                .map((f) => {
                var _a;
                return ({
                    name: (_a = f.path.split('/').pop()) !== null && _a !== void 0 ? _a : f.path,
                    path: f.path,
                    sha: '',
                });
            });
        });
    }
    getFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            // Bitbucket src endpoint returns raw content (no base64)
            const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
            const res = yield fetch(`${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src/${this.branchEnc}/${encodedPath}`, { headers: { Authorization: this.authHeader } });
            if (res.status === 404)
                return null;
            if (!res.ok)
                throw new Error(`Bitbucket get failed: ${res.status} ${res.statusText}`);
            const content = yield res.text();
            return { content, sha: '' };
        });
    }
    putFile(filePath, content, message, _sha) {
        return __awaiter(this, void 0, void 0, function* () {
            // Bitbucket writes files via multipart/form-data where the field name is the file path
            const form = new FormData();
            form.append('message', message);
            form.append('branch', this.branch);
            form.append(filePath, content);
            const res = yield fetch(`${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src`, {
                method: 'POST',
                headers: { Authorization: this.authHeader }, // no Content-Type — browser sets multipart boundary
                body: form,
            });
            if (!res.ok) {
                const err = yield res.text().catch(() => res.statusText);
                throw new Error(`Bitbucket put failed: ${res.status} – ${err}`);
            }
        });
    }
}
exports.BitbucketProvider = BitbucketProvider;

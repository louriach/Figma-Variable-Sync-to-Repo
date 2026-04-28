import type { GitProvider, FileEntry, FileContent } from './provider';

function b64Decode(b64: string): string {
  const bytes = Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export class GitHubProvider implements GitProvider {
  private readonly base = 'https://api.github.com';
  private readonly ownerEnc: string;
  private readonly repoEnc: string;
  private readonly branchEnc: string;

  constructor(
    private token: string,
    private owner: string,
    private repo: string,
    private branch: string
  ) {
    this.ownerEnc = encodeURIComponent(owner);
    this.repoEnc = encodeURIComponent(repo);
    this.branchEnc = encodeURIComponent(branch);
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async validateToken(): Promise<{ login: string }> {
    const res = await fetch(`${this.base}/user`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub auth failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { login: data.login };
  }

  async listRepos(): Promise<string[]> {
    const repos: string[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `${this.base}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        { headers: this.headers() }
      );
      if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status} ${res.statusText}`);
      const data: Array<{ full_name: string }> = await res.json();
      if (data.length === 0) break;
      repos.push(...data.map((r) => r.full_name));
      if (data.length < 100) break;
      page++;
    }
    return repos;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const branches: string[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `${this.base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
        { headers: this.headers() }
      );
      if (!res.ok) throw new Error(`GitHub list branches failed: ${res.status} ${res.statusText}`);
      const data: Array<{ name: string }> = await res.json();
      if (data.length === 0) break;
      branches.push(...data.map((b) => b.name));
      if (data.length < 100) break;
      page++;
    }
    return branches;
  }

  async ensureBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    const oEnc = encodeURIComponent(owner);
    const rEnc = encodeURIComponent(repo);

    // Check if branch already exists
    const checkRes = await fetch(
      `${this.base}/repos/${oEnc}/${rEnc}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers: this.headers() }
    );
    if (checkRes.ok) return false; // already exists

    // Get the default branch to branch from
    const repoRes = await fetch(`${this.base}/repos/${oEnc}/${rEnc}`, { headers: this.headers() });
    if (!repoRes.ok) throw new Error(`Cannot read repo info: ${repoRes.status}`);
    const repoData = await repoRes.json();
    const defaultBranch: string = repoData.default_branch;

    // Get the SHA of the default branch HEAD
    const refRes = await fetch(
      `${this.base}/repos/${oEnc}/${rEnc}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      { headers: this.headers() }
    );
    if (!refRes.ok) throw new Error(`Cannot read default branch ref: ${refRes.status}`);
    const refData = await refRes.json();
    const sha: string = refData.object.sha;

    // Create the new branch
    const createRes = await fetch(`${this.base}/repos/${oEnc}/${rEnc}/git/refs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ message: createRes.statusText }));
      throw new Error(`GitHub create branch failed: ${createRes.status} – ${err.message}`);
    }
    return true;
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const path = dirPath.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
    const res = await fetch(
      `${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${path}?ref=${this.branchEnc}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub list failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((f: { type: string; name: string }) => f.type === 'file' && f.name.endsWith('.json'))
      .map((f: { name: string; path: string; sha: string }) => ({
        name: f.name,
        path: f.path,
        sha: f.sha,
      }));
  }

  async getFile(filePath: string): Promise<FileContent | null> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(
      `${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${encodedPath}?ref=${this.branchEnc}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub get failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { content: b64Decode(data.content), sha: data.sha };
  }

  async putFile(
    filePath: string,
    content: string,
    message: string,
    sha?: string
  ): Promise<void> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const body: Record<string, unknown> = {
      message,
      content: b64Encode(content),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    const url = `${this.base}/repos/${this.ownerEnc}/${this.repoEnc}/contents/${encodedPath}`;
    let res = await fetch(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });

    // 409 = SHA conflict (stale or wrong). Re-fetch the current blob SHA and retry once.
    if (res.status === 409) {
      const current = await this.getFile(filePath);
      if (current?.sha) body.sha = current.sha;
      else delete body.sha;
      res = await fetch(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`GitHub put failed: ${res.status} – ${err.message}`);
    }
  }
}

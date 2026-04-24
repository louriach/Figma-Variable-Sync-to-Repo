import type { GitProvider, FileEntry, FileContent } from './provider';

function b64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export class BitbucketProvider implements GitProvider {
  private readonly base = 'https://api.bitbucket.org/2.0';
  private readonly authHeader: string;
  private readonly ownerEnc: string;
  private readonly repoEnc: string;
  private readonly branchEnc: string;

  constructor(
    token: string, // format: "username:app_password"
    private owner: string,
    private repo: string,
    private branch: string
  ) {
    this.authHeader = `Basic ${b64Encode(token)}`;
    this.ownerEnc = encodeURIComponent(owner);
    this.repoEnc = encodeURIComponent(repo);
    this.branchEnc = encodeURIComponent(branch);
  }

  private headers(): HeadersInit {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
    };
  }

  async validateToken(): Promise<{ login: string }> {
    const res = await fetch(`${this.base}/user`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Bitbucket auth failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { login: data.nickname ?? data.username };
  }

  async listRepos(): Promise<string[]> {
    const repos: string[] = [];
    let url: string | null =
      `${this.base}/repositories?role=member&pagelen=100&sort=-updated_on`;
    while (url) {
      const res: Response = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Bitbucket list repos failed: ${res.status} ${res.statusText}`);
      const data: { values: Array<{ full_name: string }>; next?: string } = await res.json();
      repos.push(...data.values.map((r) => r.full_name));
      url = data.next ?? null;
    }
    return repos;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const oEnc = encodeURIComponent(owner);
    const rEnc = encodeURIComponent(repo);
    const branches: string[] = [];
    let url: string | null =
      `${this.base}/repositories/${oEnc}/${rEnc}/refs/branches?pagelen=100`;
    while (url) {
      const res: Response = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Bitbucket list branches failed: ${res.status} ${res.statusText}`);
      const data: { values: Array<{ name: string }>; next?: string } = await res.json();
      branches.push(...data.values.map((b) => b.name));
      url = data.next ?? null;
    }
    return branches;
  }

  async ensureBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    const oEnc = encodeURIComponent(owner);
    const rEnc = encodeURIComponent(repo);

    const checkRes = await fetch(
      `${this.base}/repositories/${oEnc}/${rEnc}/refs/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() }
    );
    if (checkRes.ok) return false;

    // Get default branch name
    const repoRes = await fetch(`${this.base}/repositories/${oEnc}/${rEnc}`, { headers: this.headers() });
    if (!repoRes.ok) throw new Error(`Cannot read repo info: ${repoRes.status}`);
    const repoData = await repoRes.json();
    const defaultBranch: string = repoData.mainbranch.name;

    // Get HEAD commit of default branch
    const branchRes = await fetch(
      `${this.base}/repositories/${oEnc}/${rEnc}/refs/branches/${encodeURIComponent(defaultBranch)}`,
      { headers: this.headers() }
    );
    if (!branchRes.ok) throw new Error(`Cannot read default branch: ${branchRes.status}`);
    const branchData = await branchRes.json();
    const sha: string = branchData.target.hash;

    const createRes = await fetch(
      `${this.base}/repositories/${oEnc}/${rEnc}/refs/branches`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: branch, target: { hash: sha } }),
      }
    );
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ error: { message: createRes.statusText } }));
      throw new Error(`Bitbucket create branch failed: ${createRes.status} – ${err?.error?.message ?? ''}`);
    }
    return true;
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const path = dirPath.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
    const res = await fetch(
      `${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src/${this.branchEnc}/${path}?pagelen=100`,
      { headers: this.headers() }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Bitbucket list failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.values as Array<{ type: string; path: string }> ?? [])
      .filter((f) => f.type === 'commit_file' && f.path.endsWith('.json'))
      .map((f) => ({
        name: f.path.split('/').pop() ?? f.path,
        path: f.path,
        sha: '',
      }));
  }

  async getFile(filePath: string): Promise<FileContent | null> {
    // Bitbucket src endpoint returns raw content (no base64)
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(
      `${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src/${this.branchEnc}/${encodedPath}`,
      { headers: { Authorization: this.authHeader } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Bitbucket get failed: ${res.status} ${res.statusText}`);
    const content = await res.text();
    return { content, sha: '' };
  }

  async putFile(
    filePath: string,
    content: string,
    message: string,
    _sha?: string
  ): Promise<void> {
    // Bitbucket writes files via multipart/form-data where the field name is the file path
    const form = new FormData();
    form.append('message', message);
    form.append('branch', this.branch);
    form.append(filePath, content);

    const res = await fetch(
      `${this.base}/repositories/${this.ownerEnc}/${this.repoEnc}/src`,
      {
        method: 'POST',
        headers: { Authorization: this.authHeader }, // no Content-Type — browser sets multipart boundary
        body: form,
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Bitbucket put failed: ${res.status} – ${err}`);
    }
  }
}

import type { GitProvider, FileEntry, FileContent } from './provider';

export class GitHubProvider implements GitProvider {
  private readonly base = 'https://api.github.com';

  constructor(
    private token: string,
    private owner: string,
    private repo: string,
    private branch: string
  ) {}

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

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const path = dirPath.replace(/\/$/, '');
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`,
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
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${filePath}?ref=${this.branch}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub get failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const content = decodeURIComponent(
      escape(atob(data.content.replace(/\n/g, '')))
    );
    return { content, sha: data.sha };
  }

  async putFile(
    filePath: string,
    content: string,
    message: string,
    sha?: string
  ): Promise<void> {
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const body: Record<string, unknown> = {
      message,
      content: encoded,
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${filePath}`,
      { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`GitHub put failed: ${res.status} – ${err.message}`);
    }
  }
}

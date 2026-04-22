import type { GitProvider, FileEntry, FileContent } from './provider';

export class GitLabProvider implements GitProvider {
  private readonly base = 'https://gitlab.com/api/v4';
  private readonly projectId: string;

  constructor(
    private token: string,
    owner: string,
    repo: string,
    private branch: string
  ) {
    this.projectId = encodeURIComponent(`${owner}/${repo}`);
  }

  private headers(): HeadersInit {
    return {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
    };
  }

  async validateToken(): Promise<{ login: string }> {
    const res = await fetch(`${this.base}/user`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitLab auth failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { login: data.username };
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const path = dirPath.replace(/\/$/, '');
    const url = new URL(`${this.base}/projects/${this.projectId}/repository/tree`);
    url.searchParams.set('path', path);
    url.searchParams.set('ref', this.branch);
    url.searchParams.set('per_page', '100');

    const res = await fetch(url.toString(), { headers: this.headers() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitLab list failed: ${res.status} ${res.statusText}`);

    const data = await res.json();
    return (data as Array<{ type: string; name: string; path: string; id: string }>)
      .filter((f) => f.type === 'blob' && f.name.endsWith('.json'))
      .map((f) => ({ name: f.name, path: f.path, sha: f.id }));
  }

  async getFile(filePath: string): Promise<FileContent | null> {
    const encodedPath = encodeURIComponent(filePath);
    const res = await fetch(
      `${this.base}/projects/${this.projectId}/repository/files/${encodedPath}?ref=${this.branch}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitLab get failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const content = decodeURIComponent(escape(atob(data.content)));
    return { content, sha: data.content_sha256 };
  }

  async putFile(
    filePath: string,
    content: string,
    message: string,
    sha?: string
  ): Promise<void> {
    const encodedPath = encodeURIComponent(filePath);
    const existingFile = await this.getFile(filePath);
    const method = existingFile ? 'PUT' : 'POST';

    const body: Record<string, unknown> = {
      branch: this.branch,
      content,
      commit_message: message,
      encoding: 'text',
    };

    const res = await fetch(
      `${this.base}/projects/${this.projectId}/repository/files/${encodedPath}`,
      { method, headers: this.headers(), body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`GitLab put failed: ${res.status} – ${err.message}`);
    }
  }
}

export interface FileEntry {
  name: string;
  path: string;
  sha: string;
}

export interface FileContent {
  content: string;
  sha: string;
}

export interface GitProvider {
  listFiles(dirPath: string): Promise<FileEntry[]>;
  getFile(filePath: string): Promise<FileContent | null>;
  putFile(filePath: string, content: string, message: string, sha?: string): Promise<void>;
  validateToken(): Promise<{ login: string }>;
}

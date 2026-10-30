// Workspace filesystem contract. magic-ide never touches the host
// filesystem: every file lives in a workspace, which is either stored in
// the browser (the public build) or on a self-hosted server.
//
// Paths are absolute POSIX paths inside the workspace ("/src/main.rs").
// Files are bytes; readFile / writeFile are the UTF-8 text view of them.

export type EntryType = "file" | "dir";

export interface Entry {
  name: string;
  type: EntryType;
}

export interface Stat {
  type: EntryType;
  size: number;
  /** Last modification, in ms since the epoch. */
  mtime: number;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  /** Creates missing parent directories. */
  writeFile(path: string, data: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Creates missing parent directories. */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** Children of a directory, directories first, then by name. */
  readdir(path: string): Promise<Entry[]>;
  /** null when nothing exists at `path`. */
  stat(path: string): Promise<Stat | null>;
  /** Creates missing parents too; a no-op if the directory exists. */
  mkdir(path: string): Promise<void>;
  /** Removes a file, or a directory and everything in it. */
  remove(path: string): Promise<void>;
  /** Moves a file or directory. Fails if `to` exists. */
  rename(from: string, to: string): Promise<void>;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
}

/** Where workspaces are kept. */
export interface WorkspaceProvider {
  readonly kind: "browser" | "server";
  list(): Promise<WorkspaceInfo[]>;
  create(name: string): Promise<WorkspaceInfo>;
  remove(id: string): Promise<void>;
  open(id: string): Promise<FileSystem>;
}

export class FsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "EINVAL" | "EIO",
    message: string,
  ) {
    super(message);
  }
}

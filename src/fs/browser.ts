// Workspaces stored in the browser's IndexedDB. Used by the public build,
// and works offline. Each node is one record keyed by [workspace, path].

import { basename, dirname, within } from "./path";
import { FsError, type Entry, type FileSystem, type Stat, type WorkspaceInfo, type WorkspaceProvider } from "./types";

interface Node {
  ws: string;
  path: string;
  type: "file" | "dir";
  /** Text files stay strings, so they can be read back without decoding; uploads are bytes. */
  data: string | Uint8Array;
  mtime: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function size(data: string | Uint8Array): number {
  return typeof data === "string" ? encoder.encode(data).length : data.length;
}

const DB_NAME = "magic-ide";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("workspaces", { keyPath: "id" });
    db.createObjectStore("nodes", { keyPath: ["ws", "path"] });
  };
  return req(r);
}

/** Every node at or below `dir`. */
function subtree(ws: string, dir: string): IDBKeyRange {
  return dir === "/"
    ? IDBKeyRange.bound([ws, "/"], [ws, "/￿"])
    : IDBKeyRange.bound([ws, dir], [ws, dir + "/￿"]);
}

class BrowserFs implements FileSystem {
  constructor(
    private db: IDBDatabase,
    private ws: string,
  ) {}

  private store(mode: IDBTransactionMode) {
    const tx = this.db.transaction("nodes", mode);
    return { tx, nodes: tx.objectStore("nodes") };
  }

  private async get(path: string): Promise<Node | undefined> {
    if (path === "/") return { ws: this.ws, path, type: "dir", data: "", mtime: 0 };
    return req(this.store("readonly").nodes.get([this.ws, path]));
  }

  private async file(path: string): Promise<Node> {
    const n = await this.get(path);
    if (!n) throw new FsError("ENOENT", `${path}: no such file`);
    if (n.type === "dir") throw new FsError("EISDIR", `${path}: is a directory`);
    return n;
  }

  async readFile(path: string): Promise<string> {
    const { data } = await this.file(path);
    return typeof data === "string" ? data : decoder.decode(data);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const { data } = await this.file(path);
    return typeof data === "string" ? encoder.encode(data) : data;
  }

  writeFile(path: string, data: string): Promise<void> {
    return this.put(path, data);
  }

  writeBytes(path: string, data: Uint8Array): Promise<void> {
    return this.put(path, data);
  }

  private async put(path: string, data: string | Uint8Array): Promise<void> {
    const n = await this.get(path);
    if (n?.type === "dir") throw new FsError("EISDIR", `${path}: is a directory`);
    await this.mkdir(dirname(path));
    const { tx, nodes } = this.store("readwrite");
    nodes.put({ ws: this.ws, path, type: "file", data, mtime: Date.now() } satisfies Node);
    await done(tx);
  }

  async readdir(path: string): Promise<Entry[]> {
    const n = await this.get(path);
    if (!n) throw new FsError("ENOENT", `${path}: no such directory`);
    if (n.type !== "dir") throw new FsError("ENOTDIR", `${path}: not a directory`);
    const all: Node[] = await req(this.store("readonly").nodes.getAll(subtree(this.ws, path)));
    return all
      .filter((c) => c.path !== path && dirname(c.path) === path)
      .map((c) => ({ name: basename(c.path), type: c.type }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  async stat(path: string): Promise<Stat | null> {
    const n = await this.get(path);
    return n ? { type: n.type, size: size(n.data), mtime: n.mtime } : null;
  }

  async mkdir(path: string): Promise<void> {
    if (path === "/") return;
    const n = await this.get(path);
    if (n?.type === "dir") return;
    if (n) throw new FsError("EEXIST", `${path}: file exists`);
    await this.mkdir(dirname(path));
    const { tx, nodes } = this.store("readwrite");
    nodes.put({ ws: this.ws, path, type: "dir", data: "", mtime: Date.now() } satisfies Node);
    await done(tx);
  }

  async remove(path: string): Promise<void> {
    if (path === "/") throw new FsError("EINVAL", "refusing to remove the workspace root");
    if (!(await this.get(path))) throw new FsError("ENOENT", `${path}: no such file or directory`);
    const { tx, nodes } = this.store("readwrite");
    const keys = (await req(nodes.getAllKeys(subtree(this.ws, path)))) as [string, string][];
    for (const key of keys) if (within(key[1], path)) nodes.delete(key);
    await done(tx);
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === "/" || within(to, from)) throw new FsError("EINVAL", `cannot move ${from} into itself`);
    if (!(await this.get(from))) throw new FsError("ENOENT", `${from}: no such file or directory`);
    if (await this.get(to)) throw new FsError("EEXIST", `${to}: already exists`);
    await this.mkdir(dirname(to));
    const { tx, nodes } = this.store("readwrite");
    const moving: Node[] = await req(nodes.getAll(subtree(this.ws, from)));
    for (const n of moving.filter((n) => within(n.path, from))) {
      nodes.delete([this.ws, n.path]);
      nodes.put({ ...n, path: to + n.path.slice(from.length) });
    }
    await done(tx);
  }
}

export class BrowserWorkspaces implements WorkspaceProvider {
  readonly kind = "browser";
  private db = openDb();

  async list(): Promise<WorkspaceInfo[]> {
    const db = await this.db;
    const all: WorkspaceInfo[] = await req(db.transaction("workspaces").objectStore("workspaces").getAll());
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string): Promise<WorkspaceInfo> {
    const db = await this.db;
    const info = { id: crypto.randomUUID(), name };
    const tx = db.transaction("workspaces", "readwrite");
    tx.objectStore("workspaces").put(info);
    await done(tx);
    return info;
  }

  async remove(id: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["workspaces", "nodes"], "readwrite");
    tx.objectStore("workspaces").delete(id);
    tx.objectStore("nodes").delete(IDBKeyRange.bound([id, ""], [id, "￿"]));
    await done(tx);
  }

  async open(id: string): Promise<FileSystem> {
    return new BrowserFs(await this.db, id);
  }
}

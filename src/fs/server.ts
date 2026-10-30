// Workspaces hosted by a self-hosted magic-ide server (see server/ and
// docs/SELF_HOSTING.md). The client talks to it over a small JSON API:
//
//   GET    /api/config                         → { workspaces: true }
//   GET    /api/workspaces                     → WorkspaceInfo[]
//   POST   /api/workspaces          {name}     → WorkspaceInfo
//   DELETE /api/workspaces/:id
//   GET    /api/workspaces/:id/fs?path=&op=read|list|stat
//   GET    /api/workspaces/:id/fs?path=&op=bytes  → raw bytes
//   PUT    /api/workspaces/:id/fs?path=        body: raw file contents
//   POST   /api/workspaces/:id/fs?path=&op=mkdir
//   POST   /api/workspaces/:id/fs?path=&op=rename  {to}
//   DELETE /api/workspaces/:id/fs?path=
//
// Errors come back as { code, message } with a 4xx/5xx status.

import { FsError, type Entry, type FileSystem, type Stat, type WorkspaceInfo, type WorkspaceProvider } from "./types";

export interface ServerConfig {
  workspaces: boolean;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "same-origin" });
  } catch {
    throw new FsError("EIO", "workspace server unreachable");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ code: "EIO", message: res.statusText }));
    throw new FsError(err.code ?? "EIO", err.message ?? res.statusText);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

/** The server's config, or null when the app isn't served by a magic-ide server. */
export async function probeServer(): Promise<ServerConfig | null> {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const cfg = (await res.json()) as ServerConfig;
    return cfg.workspaces ? cfg : null;
  } catch {
    return null;
  }
}

class ServerFs implements FileSystem {
  constructor(private base: string) {}

  private url(path: string, op?: string): string {
    const q = new URLSearchParams({ path });
    if (op) q.set("op", op);
    return `${this.base}/fs?${q}`;
  }

  readFile(path: string): Promise<string> {
    return call(this.url(path, "read"));
  }

  async writeFile(path: string, data: string): Promise<void> {
    await call(this.url(path), { method: "PUT", body: data, headers: { "content-type": "text/plain;charset=utf-8" } });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const res = await fetch(this.url(path, "bytes"), { credentials: "same-origin" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new FsError(err.code ?? "EIO", err.message ?? res.statusText);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await call(this.url(path), { method: "PUT", body: data as BodyInit, headers: { "content-type": "application/octet-stream" } });
  }

  readdir(path: string): Promise<Entry[]> {
    return call(this.url(path, "list"));
  }

  stat(path: string): Promise<Stat | null> {
    return call(this.url(path, "stat"));
  }

  async mkdir(path: string): Promise<void> {
    await call(this.url(path, "mkdir"), { method: "POST" });
  }

  async remove(path: string): Promise<void> {
    await call(this.url(path), { method: "DELETE" });
  }

  async rename(from: string, to: string): Promise<void> {
    await call(this.url(from, "rename"), {
      method: "POST",
      body: JSON.stringify({ to }),
      headers: { "content-type": "application/json" },
    });
  }
}

export class ServerWorkspaces implements WorkspaceProvider {
  readonly kind = "server";

  list(): Promise<WorkspaceInfo[]> {
    return call("/api/workspaces");
  }

  create(name: string): Promise<WorkspaceInfo> {
    return call("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    });
  }

  async remove(id: string): Promise<void> {
    await call(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async open(id: string): Promise<FileSystem> {
    return new ServerFs(`/api/workspaces/${encodeURIComponent(id)}`);
  }
}

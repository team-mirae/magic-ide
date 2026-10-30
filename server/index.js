#!/usr/bin/env node
// Self-hosted magic-ide: serves the built app and hosts workspaces on this
// machine's disk, under MAGIC_IDE_DATA. No dependencies beyond Node.
//
//   npm run build && npm run serve
//
// Environment:
//   PORT              port to listen on (default 8080)
//   HOST              interface to bind (default 127.0.0.1)
//   MAGIC_IDE_DATA    where workspaces live (default ./data)
//   MAGIC_IDE_USER    with MAGIC_IDE_PASSWORD, require HTTP Basic auth
//   MAGIC_IDE_PASSWORD
//
// The API is documented in src/fs/server.ts and docs/SELF_HOSTING.md.

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DATA = path.resolve(process.env.MAGIC_IDE_DATA ?? path.join(ROOT, "data"));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const USER = process.env.MAGIC_IDE_USER ?? "";
const PASSWORD = process.env.MAGIC_IDE_PASSWORD ?? "";
const MAX_BODY = 64 * 1024 * 1024;
const INDEX = path.join(DATA, "workspaces.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ts": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (m) => new HttpError(404, "ENOENT", m);

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX, "utf8"));
  } catch {
    return [];
  }
}

async function writeIndex(list) {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(INDEX + ".tmp", JSON.stringify(list, null, 2));
  await fs.rename(INDEX + ".tmp", INDEX);
}

/** Map a workspace path to disk, refusing anything that escapes the workspace (.. or symlinks). */
async function diskPath(ws, p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new HttpError(400, "EINVAL", "bad path");
  const base = path.join(DATA, ws);
  const full = path.resolve(base, "." + path.posix.normalize(p));
  if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(400, "EINVAL", "path escapes the workspace");
  // Resolve symlinks on the deepest existing ancestor.
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const realBase = await fs.realpath(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new HttpError(400, "EINVAL", "path escapes the workspace");
      break;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (probe === base) break;
      probe = path.dirname(probe);
    }
  }
  return full;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "EINVAL", "file too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function authorized(req) {
  if (!USER && !PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], "base64").toString());
  const want = Buffer.from(`${USER}:${PASSWORD}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  if (parts[0] === "config") return send(res, 200, { workspaces: true });
  if (parts[0] !== "workspaces") throw notFound("no such endpoint");

  if (parts.length === 1) {
    if (req.method === "GET") return send(res, 200, await readIndex());
    if (req.method === "POST") {
      const { name } = JSON.parse((await readBody(req)).toString() || "{}");
      if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "EINVAL", "name required");
      const info = { id: randomUUID(), name: name.trim() };
      await fs.mkdir(path.join(DATA, info.id), { recursive: true });
      await writeIndex([...(await readIndex()), info]);
      return send(res, 201, info);
    }
  }

  const id = parts[1];
  const list = await readIndex();
  if (!list.some((w) => w.id === id)) throw notFound("no such workspace");

  if (parts.length === 2 && req.method === "DELETE") {
    await fs.rm(path.join(DATA, id), { recursive: true, force: true });
    await writeIndex(list.filter((w) => w.id !== id));
    return send(res, 200, {});
  }
  if (parts[2] !== "fs") throw notFound("no such endpoint");

  const p = url.searchParams.get("path") ?? "/";
  const op = url.searchParams.get("op") ?? "";
  const full = await diskPath(id, p);
  const stat = await fs.stat(full).catch(() => null);

  if (req.method === "GET") {
    if (op === "stat") {
      return send(res, 200, stat ? { type: stat.isDirectory() ? "dir" : "file", size: stat.size, mtime: stat.mtimeMs } : null);
    }
    if (!stat) throw notFound(`${p}: no such file or directory`);
    if (op === "list") {
      if (!stat.isDirectory()) throw new HttpError(400, "ENOTDIR", `${p}: not a directory`);
      const entries = (await fs.readdir(full, { withFileTypes: true }))
        .filter((e) => e.isDirectory() || e.isFile())
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return send(res, 200, entries);
    }
    if (stat.isDirectory()) throw new HttpError(400, "EISDIR", `${p}: is a directory`);
    if (op === "bytes") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size, "cache-control": "no-store" });
      return void createReadStream(full).pipe(res);
    }
    return send(res, 200, await fs.readFile(full, "utf8"), "text/plain; charset=utf-8");
  }
  if (req.method === "PUT") {
    if (stat?.isDirectory()) throw new HttpError(400, "EISDIR", `${p}: is a directory`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, await readBody(req));
    return send(res, 200, {});
  }
  if (req.method === "POST" && op === "mkdir") {
    if (stat && !stat.isDirectory()) throw new HttpError(409, "EEXIST", `${p}: file exists`);
    await fs.mkdir(full, { recursive: true });
    return send(res, 200, {});
  }
  if (req.method === "POST" && op === "rename") {
    const { to } = JSON.parse((await readBody(req)).toString() || "{}");
    const dest = await diskPath(id, to);
    if (!stat) throw notFound(`${p}: no such file or directory`);
    if (await fs.stat(dest).catch(() => null)) throw new HttpError(409, "EEXIST", `${to}: already exists`);
    if (dest.startsWith(full + path.sep)) throw new HttpError(400, "EINVAL", `cannot move ${p} into itself`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(full, dest);
    return send(res, 200, {});
  }
  if (req.method === "DELETE") {
    if (p === "/") throw new HttpError(400, "EINVAL", "refusing to remove the workspace root");
    if (!stat) throw notFound(`${p}: no such file or directory`);
    await fs.rm(full, { recursive: true, force: true });
    return send(res, 200, {});
  }
  throw new HttpError(405, "EINVAL", "method not allowed");
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  let file = path.join(DIST, path.posix.normalize(rel));
  if (!file.startsWith(DIST)) throw notFound("not found");
  let st = await fs.stat(file).catch(() => null);
  if (!st || st.isDirectory()) {
    // Single-page app: unknown paths get the app.
    file = path.join(DIST, "index.html");
    rel = "/index.html";
    st = await fs.stat(file).catch(() => null);
    if (!st) throw new HttpError(500, "EIO", "dist/ is missing; run npm run build first");
  }
  const immutable = rel.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (!authorized(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="magic-ide", charset="UTF-8"' });
      return void res.end();
    }
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const code = e instanceof HttpError ? e.code : e.code === "ENOENT" ? "ENOENT" : "EIO";
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { code, message: e.message });
    else res.end();
  }
});

await fs.mkdir(DATA, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`magic-ide on http://${HOST}:${PORT}  (workspaces in ${DATA}${USER || PASSWORD ? ", basic auth on" : ""})`);
});

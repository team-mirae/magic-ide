// Loads plugin modules and keeps track of what they contribute. Installed
// module URLs are remembered in localStorage and loaded again on start;
// the service worker caches the module files so they still load offline.

import { basename, extname } from "../fs/path";
import { PLUGIN_API_VERSION, type Highlighter, type PluginModule, type Runner, type Viewer } from "./api";
import { plaintext } from "./builtin/plaintext";
import { javascriptRunner } from "./builtin/javascript";

const STORAGE_KEY = "magic-ide.plugins";

/** A module that came from a URL, or a built-in. */
export interface Installed {
  url: string | null;
  module: PluginModule;
}

function savedUrls(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function saveUrls(urls: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(urls));
  } catch {
    // Private mode or storage blocked: the plugin stays loaded for this session.
  }
}

/** Check a module's shape, so a broken plugin fails at install instead of mid-edit. */
export function validate(m: unknown): PluginModule {
  const mod = m as PluginModule;
  if (!mod || typeof mod !== "object") throw new Error("default export is not a plugin module");
  if (mod.api !== PLUGIN_API_VERSION) throw new Error(`plugin api ${String(mod.api)} is not supported (need ${PLUGIN_API_VERSION})`);
  if (typeof mod.id !== "string" || !mod.id) throw new Error("plugin module needs an id");
  for (const h of mod.highlighters ?? []) {
    if (typeof h.id !== "string" || typeof h.startState !== "function" || typeof h.tokenizeLine !== "function") {
      throw new Error(`highlighter ${String(h.id)} must have id, startState and tokenizeLine`);
    }
  }
  for (const r of mod.runners ?? []) {
    if (typeof r.id !== "string" || !Array.isArray(r.extensions) || typeof r.run !== "function") {
      throw new Error(`runner ${String(r.id)} must have id, extensions and run`);
    }
  }
  for (const v of mod.viewers ?? []) {
    if (typeof v.id !== "string" || typeof v.mount !== "function" || (v.encoding !== "text" && v.encoding !== "binary")) {
      throw new Error(`viewer ${String(v.id)} must have id, encoding and mount`);
    }
  }
  return mod;
}

const BUILTIN: PluginModule = {
  api: 1,
  id: "builtin",
  name: "Built-in",
  highlighters: [plaintext],
  runners: [javascriptRunner],
};

export class PluginRegistry {
  private modules: Installed[] = [{ url: null, module: BUILTIN }];
  private prepared = new Map<string, Promise<void>>();
  /** Called whenever the set of highlighters or runners changes. */
  onChange: () => void = () => {};

  /** Load every saved module. Failures are reported but don't stop the others. */
  async loadSaved(report: (url: string, err: unknown) => void): Promise<void> {
    await Promise.all(
      savedUrls().map((url) =>
        this.load(url).catch((err) => {
          report(url, err);
        }),
      ),
    );
  }

  private async load(url: string): Promise<PluginModule> {
    const ns = await import(/* @vite-ignore */ url);
    const mod = validate(ns.default);
    this.modules = this.modules.filter((m) => m.module.id !== mod.id && m.url !== url);
    this.modules.push({ url, module: mod });
    this.onChange();
    return mod;
  }

  /** Install a module from a URL and remember it. */
  async install(url: string): Promise<PluginModule> {
    const resolved = new URL(url, location.href).href;
    const mod = await this.load(resolved);
    saveUrls([...savedUrls().filter((u) => u !== resolved), resolved]);
    return mod;
  }

  /** Remove a module by its id or URL. Returns whether anything was removed. */
  uninstall(idOrUrl: string): boolean {
    const hit = this.modules.find((m) => m.url && (m.module.id === idOrUrl || m.url === idOrUrl));
    if (!hit) return false;
    this.modules = this.modules.filter((m) => m !== hit);
    saveUrls(savedUrls().filter((u) => u !== hit.url));
    this.onChange();
    return true;
  }

  list(): Installed[] {
    return [...this.modules];
  }

  /** Later modules win, so an installed plugin overrides a built-in. */
  private all<T>(pick: (m: PluginModule) => T[] | undefined): T[] {
    return this.modules.flatMap((m) => pick(m.module) ?? []).reverse();
  }

  highlighterFor(path: string): Highlighter<any> {
    const name = basename(path);
    const ext = extname(path);
    const hs = this.all((m) => m.highlighters);
    return hs.find((h) => h.filenames?.includes(name)) ?? hs.find((h) => h.extensions?.includes(ext)) ?? plaintext;
  }

  runnerFor(path: string): Runner | undefined {
    const ext = extname(path);
    return this.all((m) => m.runners).find((r) => r.extensions.includes(ext));
  }

  /** Viewers that can open `path`; the default one, if any, first. */
  viewersFor(path: string): Viewer[] {
    const name = basename(path);
    const ext = extname(path);
    const vs = this.all((m) => m.viewers).filter((v) => v.filenames?.includes(name) || v.extensions?.includes(ext));
    return vs.sort((a, b) => Number(!!b.default) - Number(!!a.default));
  }

  defaultViewer(path: string): Viewer | undefined {
    return this.viewersFor(path).find((v) => v.default);
  }

  viewer(id: string): Viewer | undefined {
    return this.all((m) => m.viewers).find((v) => v.id === id);
  }

  runners(): Runner[] {
    return this.all((m) => m.runners);
  }

  highlighters(): Highlighter<any>[] {
    return this.all((m) => m.highlighters);
  }

  /** Run a runner's `prepare` once per page load. */
  prepare(r: Runner, log: (text: string) => void): Promise<void> {
    let p = this.prepared.get(r.id);
    if (!p) {
      p = r.prepare ? r.prepare(log) : Promise.resolve();
      p.catch(() => this.prepared.delete(r.id));
      this.prepared.set(r.id, p);
    }
    return p;
  }
}

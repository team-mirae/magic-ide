// The IDE: header, explorer, tabs (zencode or a viewer plugin), terminal.
//
// On wide screens the explorer, editor and terminal sit side by side. On
// phones only one pane shows at a time, picked from the header, and the
// on-screen key bar sits above the soft keyboard.

import { basename, dirname, extname, resolve } from "./fs/path";
import { BrowserWorkspaces } from "./fs/browser";
import { probeServer, ServerWorkspaces } from "./fs/server";
import type { FileSystem, WorkspaceInfo, WorkspaceProvider } from "./fs/types";
import type { Viewer, ViewerInstance } from "./plugins/api";
import { PluginRegistry } from "./plugins/registry";
import { ask, confirm, panel } from "./ui/dialog";
import { Explorer } from "./ui/explorer";
import { createKeyBar, setExtraKeys } from "./ui/keybar";
import { contextMenu, installGlobalMenus, showMenu, type MenuItem } from "./ui/menu";
import { Terminal } from "./ui/terminal";
import { Doc } from "./zencode/doc";
import { Editor } from "./zencode/editor";

const LAST_WS = "magic-ide.workspace";
const TABS = "magic-ide.tabs.";

type Pane = "files" | "editor" | "terminal";

interface Tab {
  path: string;
  kind: "zen" | "viewer";
  doc?: Doc;
  viewer?: Viewer;
  el?: HTMLElement;
  instance?: ViewerInstance;
  dirty: boolean;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
};

const WELCOME = `# magic-ide

An IDE that works like magic. Everything lives in this browser, and it
keeps working offline once loaded. Install it as an app from your
browser's menu.

- Files: create, rename, upload and download from the explorer.
- Editor: zencode. Press ⌃/ or F1 for its keys.
- Terminal: a small shell over this workspace. Try \`ls\`, \`run hello.js\`.

Syntax highlighters, code runners and file viewers are plugins:
\`plugin add <url>\` in the terminal. See docs/PLUGINS.md in the repository.

MIT · Mirae Research
`;

const HELLO = `// Run me from the terminal: run hello.js
const name = argv[0] ?? "magic-ide";
console.log(\`Hello from \${name}!\`);
`;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: it's only a convenience.
  }
}

/** Text files only: a NUL byte early on means binary. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export class App {
  private provider!: WorkspaceProvider;
  private workspace: WorkspaceInfo | null = null;
  private fsys: FileSystem | null = null;
  private plugins = new PluginRegistry();
  private editor: Editor;
  private explorer: Explorer;
  private terminal: Terminal;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private pane: Pane = "editor";

  private root: HTMLElement;
  private tabsEl!: HTMLElement;
  private stage!: HTMLElement;
  private wsBtn!: HTMLButtonElement;
  private modeEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    installGlobalMenus();

    this.editor = new Editor({
      save: async (doc) => {
        await this.needFs().writeFile(doc.path, doc.buf.serialize());
        void this.explorer.refresh();
      },
      resolve: (doc, input) => resolve(dirname(doc.path), input),
      exists: async (p) => !!(await this.needFs().stat(p)),
      write: async (p, text) => {
        await this.needFs().writeFile(p, text);
        void this.explorer.refresh();
      },
      close: (doc) => {
        const t = this.tabs.find((t) => t.doc === doc);
        if (t) this.closeTab(t, true);
      },
      changed: (doc) => {
        const t = this.tabs.find((t) => t.doc === doc);
        if (t) {
          t.dirty = doc.dirty;
          this.renderTabs();
        }
      },
    });

    this.explorer = new Explorer({
      fs: () => this.fsys,
      workspaceName: () => this.workspace?.name ?? "workspace",
      open: (p, viewerId) => void this.open(p, viewerId),
      openWith: (p) => this.plugins.viewersFor(p).map((v) => ({ id: v.id, name: v.name })),
      canRun: (p) => !!this.plugins.runnerFor(p),
      run: (p) => {
        this.show("terminal");
        void this.terminal.execute(`run ${JSON.stringify(p)}`);
      },
      renamed: (from, to) => {
        for (const t of this.tabs) {
          if (t.path === from || t.path.startsWith(from + "/")) {
            t.path = to + t.path.slice(from.length);
            if (t.doc) {
              t.doc.path = t.path;
              t.doc.setHighlighter(this.plugins.highlighterFor(t.path));
            }
          }
        }
        this.renderTabs();
        this.editor.refresh();
        this.saveTabs();
      },
      removed: (p) => {
        for (const t of [...this.tabs]) if (t.path === p || t.path.startsWith(p + "/")) this.closeTab(t, true);
      },
      error: (m) => this.editor.setStatus(m, true),
    });

    this.terminal = new Terminal({
      fs: () => this.fsys,
      plugins: this.plugins,
      open: (p) => void this.open(p),
      changed: () => void this.explorer.refresh(),
      workspaces: (args, out) => this.workspaceCommand(args, out),
    });
    setExtraKeys(this.terminal.input, Terminal.extraKeys);

    this.plugins.onChange = () => {
      for (const t of this.tabs) t.doc?.setHighlighter(this.plugins.highlighterFor(t.path));
      this.editor.refresh();
    };

    this.build();
  }

  private build(): void {
    this.root.innerHTML = `
      <header class="top">
        <div class="brand">magic-ide</div>
        <button type="button" class="ws-btn" title="Workspace"></button>
        <span class="mode"></span>
        <nav class="panes" aria-label="Panes">
          <button type="button" data-pane="files">Files</button>
          <button type="button" data-pane="editor">Editor</button>
          <button type="button" data-pane="terminal">Terminal</button>
        </nav>
        <button type="button" class="more" aria-label="Menu" title="Menu">⋯</button>
      </header>
      <main class="body">
        <aside class="side"></aside>
        <section class="center">
          <div class="tabs" role="tablist"></div>
          <div class="stage"></div>
        </section>
        <section class="bottom"></section>
      </main>`;
    const $ = (s: string) => this.root.querySelector(s) as HTMLElement;
    $(".side").appendChild(this.explorer.root);
    this.tabsEl = $(".tabs");
    this.stage = $(".stage");
    this.stage.appendChild(this.editor.root);
    $(".bottom").appendChild(this.terminal.root);
    this.root.appendChild(createKeyBar());
    this.wsBtn = $(".ws-btn") as HTMLButtonElement;
    this.modeEl = $(".mode");

    this.wsBtn.addEventListener("click", () => {
      const r = this.wsBtn.getBoundingClientRect();
      void this.workspaceMenu().then((items) => showMenu(r.left, r.bottom, items));
    });
    $(".more").addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showMenu(r.right - 220, r.bottom, this.appMenu());
    });
    $(".panes").addEventListener("click", (e) => {
      const p = (e.target as HTMLElement).closest("button")?.dataset.pane as Pane | undefined;
      if (p) this.toggle(p);
    });
    contextMenu(this.tabsEl, (target) => {
      const el = target.closest(".tab") as HTMLElement | null;
      const t = el ? this.tabs[Number(el.dataset.i)] : null;
      if (!t) return null;
      return [
        { label: "Close", hint: "⌃X", action: () => void this.requestClose(t) },
        { label: "Close Others", action: () => this.tabs.filter((o) => o !== t).forEach((o) => void this.requestClose(o)) },
        "separator",
        { label: "Reveal in Files", action: () => void this.explorer.reveal(t.path).then(() => this.show("files")) },
        { label: "Copy Path", action: () => void navigator.clipboard?.writeText(t.path).catch(() => {}) },
      ];
    });
    // Clicking the header, tabs or gaps never shows the browser menu either.
    contextMenu(this.root, () => null);

    window.addEventListener("beforeunload", (e) => {
      if (this.tabs.some((t) => t.dirty)) e.preventDefault();
    });
    window.addEventListener("online", () => this.renderMode());
    window.addEventListener("offline", () => this.renderMode());
    // ⌃S / ⌘S in a viewer tab saves through the viewer.
    this.stage.addEventListener("keydown", (e) => {
      const t = this.active;
      if (t?.kind === "viewer" && (e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        e.preventDefault();
        void this.saveViewer(t);
      }
    });
    this.show(matchMedia("(max-width: 760px)").matches ? "files" : "editor");
    matchMedia("(max-width: 760px)").addEventListener("change", () => this.syncPaneButtons());
  }

  async start(): Promise<void> {
    navigator.storage?.persist?.().catch(() => {});
    const server = await probeServer();
    this.provider = server ? new ServerWorkspaces() : new BrowserWorkspaces();
    this.renderMode();
    await this.plugins.loadSaved((url, err) => this.terminal.write(`plugin ${url} failed to load: ${(err as Error).message}\n`, "term-err"));
    let list = await this.provider.list();
    if (!list.length) {
      const ws = await this.provider.create("default");
      const fs = await this.provider.open(ws.id);
      await fs.writeFile("/README.md", WELCOME);
      await fs.writeFile("/hello.js", HELLO);
      list = [ws];
    }
    const last = safeGet(LAST_WS);
    await this.useWorkspace(list.find((w) => w.id === last) ?? list[0]);
  }

  // ----- workspaces ---------------------------------------------------------------

  private needFs(): FileSystem {
    if (!this.fsys) throw new Error("no workspace open");
    return this.fsys;
  }

  private async useWorkspace(ws: WorkspaceInfo): Promise<void> {
    for (const t of [...this.tabs]) {
      if (t.dirty && !(await confirm(`${t.path} has unsaved changes. Discard them?`, "Discard", true))) return;
    }
    for (const t of [...this.tabs]) this.closeTab(t, true);
    this.workspace = ws;
    this.fsys = await this.provider.open(ws.id);
    safeSet(LAST_WS, ws.id);
    this.wsBtn.textContent = ws.name;
    this.wsBtn.setAttribute("aria-label", `Workspace: ${ws.name}`);
    this.terminal.cwd = "/";
    await this.explorer.refresh();
    let saved: string[] = [];
    try {
      saved = JSON.parse(safeGet(TABS + ws.id) ?? "[]");
    } catch {
      saved = [];
    }
    for (const p of saved) if (typeof p === "string" && (await this.fsys.stat(p))) await this.open(p, undefined, false);
    if (!this.tabs.length && (await this.fsys.stat("/README.md"))) await this.open("/README.md", undefined, false);
  }

  private async createWorkspace(): Promise<void> {
    const name = await ask("New workspace", "", "Create");
    if (!name) return;
    await this.useWorkspace(await this.provider.create(name));
  }

  private async deleteWorkspace(ws: WorkspaceInfo): Promise<void> {
    if (!(await confirm(`Delete workspace "${ws.name}" and all its files? This can't be undone.`, "Delete", true))) return;
    await this.provider.remove(ws.id);
    const rest = await this.provider.list();
    if (this.workspace?.id === ws.id) {
      for (const t of [...this.tabs]) this.closeTab(t, true);
      this.workspace = null;
      this.fsys = null;
      if (rest.length) await this.useWorkspace(rest[0]);
      else {
        this.wsBtn.textContent = "No workspace";
        await this.explorer.refresh();
      }
    }
  }

  private async workspaceMenu(): Promise<MenuItem[]> {
    const list = await this.provider.list();
    return [
      ...list.map((w): MenuItem => ({ label: (w.id === this.workspace?.id ? "● " : "  ") + w.name, action: () => void this.useWorkspace(w) })),
      "separator",
      { label: "New Workspace…", action: () => void this.createWorkspace() },
      { label: "Download Workspace (.zip)", action: () => void this.explorer.downloadWorkspace(), disabled: !this.fsys },
      { label: "Delete This Workspace…", action: () => this.workspace && void this.deleteWorkspace(this.workspace), disabled: !this.workspace, danger: true },
    ];
  }

  private async workspaceCommand([sub, ...rest]: string[], out: (s: string) => void): Promise<void> {
    const name = rest.join(" ");
    const list = await this.provider.list();
    const find = () => {
      const w = list.find((w) => w.name === name || w.id === name);
      if (!w) throw new Error(`workspace: ${name}: no such workspace`);
      return w;
    };
    if (!sub) {
      for (const w of list) out(`${w.id === this.workspace?.id ? "*" : " "} ${w.name}\n`);
    } else if (sub === "new") {
      if (!name) throw new Error("usage: workspace new <name>");
      await this.useWorkspace(await this.provider.create(name));
    } else if (sub === "use") {
      await this.useWorkspace(find());
    } else if (sub === "rm") {
      await this.deleteWorkspace(find());
    } else {
      throw new Error("usage: workspace [new|use|rm <name>]");
    }
  }

  // ----- tabs ------------------------------------------------------------------------

  /** Open a file in a tab: its default viewer plugin, or zencode. `viewerId` "zencode" forces the editor. */
  async open(path: string, viewerId?: string, focus = true): Promise<void> {
    const fs = this.needFs();
    const viewer = viewerId === "zencode" ? undefined : viewerId ? this.plugins.viewer(viewerId) : this.plugins.defaultViewer(path);
    const kind = viewer ? "viewer" : "zen";
    let tab = this.tabs.find((t) => t.path === path && t.kind === kind && t.viewer === viewer);
    if (!tab) {
      try {
        if (viewer) {
          tab = { path, kind, viewer, dirty: false, el: document.createElement("div") };
          tab.el!.className = "viewer";
          tab.el!.tabIndex = -1;
          this.tabs.push(tab);
          const t = tab;
          t.instance = await viewer.mount(t.el!, {
            path,
            mime: MIME[extname(path)] ?? "",
            read: () => (viewer.encoding === "binary" ? fs.readBytes(t.path) : fs.readFile(t.path)),
            write: async (data) => {
              if (typeof data === "string") await fs.writeFile(t.path, data);
              else await fs.writeBytes(t.path, data);
              void this.explorer.refresh();
            },
            setDirty: (d) => {
              t.dirty = d;
              this.renderTabs();
            },
            setStatus: (s) => this.editor.setStatus(s),
          });
        } else {
          const bytes = await fs.readBytes(path);
          if (looksBinary(bytes)) {
            const others = this.plugins.viewersFor(path);
            this.editor.setStatus(
              others.length ? `${basename(path)} is binary; open it with ${others[0].name}` : `${basename(path)} is binary. Install a viewer plugin to open it.`,
              true,
            );
            if (others.length) return this.open(path, others[0].id, focus);
            return;
          }
          const doc = new Doc(path, new TextDecoder().decode(bytes), this.plugins.highlighterFor(path));
          tab = { path, kind, doc, dirty: false };
          this.tabs.push(tab);
        }
      } catch (e) {
        if (tab) this.tabs = this.tabs.filter((t) => t !== tab);
        this.editor.setStatus(`Can't open ${path}: ${(e as Error).message}`, true);
        return;
      }
    }
    this.activate(tab, focus);
    this.saveTabs();
  }

  private activate(tab: Tab | null, focus = true): void {
    this.active = tab;
    // Show the pane first: a hidden element can't take focus.
    if (focus && tab) this.show("editor");
    for (const t of this.tabs) if (t.el) t.el.hidden = t !== tab;
    if (tab?.kind === "viewer") {
      if (!tab.el!.isConnected) this.stage.appendChild(tab.el!);
      this.editor.root.hidden = true;
      this.editor.setDoc(null);
      if (focus) (tab.instance?.focus ?? (() => tab.el!.focus()))();
    } else {
      this.editor.root.hidden = false;
      this.editor.setDoc(tab?.doc ?? null);
      if (focus && tab) this.editor.focus();
    }
    this.renderTabs();
  }

  private async requestClose(t: Tab): Promise<void> {
    if (t.dirty && !(await confirm(`${t.path} has unsaved changes. Close it anyway?`, "Discard", true))) return;
    this.closeTab(t, true);
  }

  private closeTab(t: Tab, force: boolean): void {
    if (!force && t.dirty) return void this.requestClose(t);
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    try {
      t.instance?.dispose();
    } catch (e) {
      console.error(e);
    }
    t.el?.remove();
    if (this.active === t) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    else this.renderTabs();
    this.saveTabs();
  }

  private async saveViewer(t: Tab): Promise<void> {
    try {
      await t.instance?.save?.();
    } catch (e) {
      this.editor.setStatus(`Error writing: ${(e as Error).message}`, true);
    }
  }

  private saveTabs(): void {
    if (this.workspace) safeSet(TABS + this.workspace.id, JSON.stringify([...new Set(this.tabs.map((t) => t.path))]));
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = "";
    this.tabs.forEach((t, i) => {
      const el = document.createElement("div");
      el.className = "tab" + (t === this.active ? " active" : "") + (t.dirty ? " dirty" : "");
      el.dataset.i = String(i);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(t === this.active));
      el.title = t.path + (t.viewer ? ` · ${t.viewer.name}` : "");
      el.innerHTML = `<span class="tab-name"></span><button type="button" class="tab-x" aria-label="Close">×</button>`;
      el.firstElementChild!.textContent = basename(t.path) + (t.viewer ? ` · ${t.viewer.name}` : "");
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("tab-x")) void this.requestClose(t);
        else this.activate(t);
      });
      this.tabsEl.appendChild(el);
    });
    this.tabsEl.hidden = !this.tabs.length;
  }

  // ----- panes ------------------------------------------------------------------------

  private narrow(): boolean {
    return matchMedia("(max-width: 760px)").matches;
  }

  /** Phones show one pane; wide screens toggle the explorer and terminal around the editor. */
  private toggle(p: Pane): void {
    if (this.narrow()) return this.show(p);
    if (p === "editor") return this.show("editor");
    this.root.classList.toggle(`hide-${p}`);
    this.syncPaneButtons();
    if (!this.root.classList.contains(`hide-${p}`)) (p === "files" ? this.explorer : this.terminal).focus();
  }

  show(p: Pane): void {
    this.pane = p;
    this.root.dataset.pane = p;
    this.root.classList.remove(`hide-${p}`);
    this.syncPaneButtons();
    if (p === "terminal") this.terminal.focus();
    if (p === "files" && this.narrow()) this.explorer.focus();
  }

  private syncPaneButtons(): void {
    this.root.querySelectorAll<HTMLButtonElement>(".panes button").forEach((b) => {
      const p = b.dataset.pane as Pane;
      const on = this.narrow() ? p === this.pane : p === "editor" || !this.root.classList.contains(`hide-${p}`);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  private renderMode(): void {
    const offline = !navigator.onLine;
    const kind = this.provider?.kind === "server" ? "server" : "browser";
    this.modeEl.textContent = offline ? `${kind} · offline` : kind;
    this.modeEl.title = kind === "server" ? "Workspaces are hosted by this server" : "Workspaces are stored in this browser";
  }

  // ----- menus & dialogs -----------------------------------------------------------------

  private appMenu(): MenuItem[] {
    const install = (window as Window & { __installPrompt?: { prompt(): void } }).__installPrompt;
    return [
      { label: "Plugins…", action: () => this.pluginsDialog() },
      { label: "Editor Help", hint: "F1", action: () => this.editor.perform("help") },
      ...(install ? [{ label: "Install App", action: () => install.prompt() } as MenuItem] : []),
      "separator",
      { label: "About magic-ide", action: () => this.about() },
    ];
  }

  private pluginsDialog(): void {
    const body = document.createElement("div");
    body.className = "plugins";
    const draw = () => {
      body.innerHTML = `<ul class="plugin-list"></ul>
        <form class="plugin-add"><input placeholder="https://…/plugin.js" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="url"><button type="submit" class="primary">Install</button></form>
        <p class="plugin-note">A plugin is an ES module adding highlighters, runners or viewers. It runs with full access to this app, so only install code you trust.</p>`;
      const ul = body.querySelector("ul")!;
      for (const m of this.plugins.list()) {
        const li = document.createElement("li");
        const parts = [
          ...(m.module.highlighters ?? []).map((h) => `highlight ${h.name}`),
          ...(m.module.runners ?? []).map((r) => `run ${r.name}`),
          ...(m.module.viewers ?? []).map((v) => `view ${v.name}`),
        ];
        li.innerHTML = `<div><b></b><small></small></div>`;
        li.querySelector("b")!.textContent = m.module.name + (m.module.version ? ` ${m.module.version}` : "");
        li.querySelector("small")!.textContent = parts.join(" · ") + (m.url ? `\n${m.url}` : "");
        if (m.url) {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "danger";
          rm.textContent = "Remove";
          rm.addEventListener("click", () => {
            this.plugins.uninstall(m.url!);
            draw();
          });
          li.appendChild(rm);
        }
        ul.appendChild(li);
      }
      body.querySelector("form")!.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = body.querySelector("input")!;
        try {
          await this.plugins.install(input.value.trim());
          draw();
        } catch (err) {
          input.setCustomValidity((err as Error).message);
          input.reportValidity();
          input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
        }
      });
    };
    draw();
    panel("Plugins", body);
  }

  private about(): void {
    const body = document.createElement("div");
    body.className = "about";
    body.innerHTML = `<p><b>magic-ide</b>, an IDE that works like magic.</p>
      <p>Editor: <a href="https://github.com/team-mirae/zencode" target="_blank" rel="noopener">zencode</a> · 젠코드 · ゼンコード</p>
      <p>MIT License · Mirae Research</p>
      <p><a href="https://github.com/team-mirae/magic-ide" target="_blank" rel="noopener">github.com/team-mirae/magic-ide</a></p>`;
    panel("About", body);
  }
}

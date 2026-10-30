// The file explorer. Selection works the same on every OS and device:
//
// - click / tap selects and opens; ⇧+click selects a range from the last
//   clicked item; ⌃+click or ⌘+click toggles one item
// - one-finger drag selects a range like ⇧+drag; two fingers scroll
// - right click, ⌃+click on macOS, or a long press opens the menu, which
//   acts on the whole selection
// - keys: ↑↓ (⇧ extends), ←→ collapse / expand, Enter opens, F2 renames,
//   Delete or ⌫ removes

import { basename, dirname, join, within } from "../fs/path";
import type { Entry, FileSystem } from "../fs/types";
import { collect, downloadBlob, zip } from "../fs/zip";
import { ask, confirm } from "./dialog";
import { capture, contextMenu, showMenu, type MenuItem } from "./menu";

const TAP_SLOP = 8;

export interface ExplorerHost {
  fs(): FileSystem | null;
  workspaceName(): string;
  open(path: string, viewerId?: string): void;
  /** Viewers that can open a path, for "Open With…". */
  openWith(path: string): { id: string; name: string }[];
  canRun(path: string): boolean;
  run(path: string): void;
  renamed(from: string, to: string): void;
  removed(path: string): void;
  error(message: string): void;
}

interface Row {
  path: string;
  name: string;
  type: "file" | "dir";
  depth: number;
}

export class Explorer {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private expanded = new Set<string>(["/"]);
  private children = new Map<string, Entry[]>();
  private rows: Row[] = [];
  private selected = new Set<string>();
  private anchor: string | null = null;
  private focusPath: string | null = null;
  private uploadInput: HTMLInputElement;
  private uploadDir = "/";

  constructor(private host: ExplorerHost) {
    this.root = document.createElement("div");
    this.root.className = "explorer";
    this.root.innerHTML = `
      <div class="ex-head">
        <span class="ex-title">Files</span>
        <button type="button" data-act="file" title="New File">+ File</button>
        <button type="button" data-act="dir" title="New Folder">+ Folder</button>
        <button type="button" data-act="menu" title="More" aria-label="More">⋯</button>
      </div>
      <div class="ex-list" tabindex="0" role="tree" aria-label="Files"></div>
      <input type="file" multiple hidden>`;
    this.list = this.root.querySelector(".ex-list")!;
    this.uploadInput = this.root.querySelector("input[type=file]")!;
    this.uploadInput.addEventListener("change", () => {
      void this.upload(this.uploadDir, [...(this.uploadInput.files ?? [])]);
      this.uploadInput.value = "";
    });
    this.root.querySelector(".ex-head")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "file") void this.newFile(this.targetDir());
      if (act === "dir") void this.newFolder(this.targetDir());
      if (act === "menu") {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        showMenu(r.left, r.bottom, this.backgroundMenu());
      }
    });
    contextMenu(this.list, (target) => this.menuFor(target));
    this.bindPointer();
    this.bindKeys();
    this.bindDrop();
  }

  focus(): void {
    this.list.focus({ preventScroll: true });
  }

  /** Reload the tree from the filesystem, keeping what was expanded. */
  async refresh(): Promise<void> {
    const fs = this.host.fs();
    this.children.clear();
    if (!fs) {
      this.rows = [];
      return this.render();
    }
    const load = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir);
        this.children.set(dir, entries);
        await Promise.all(entries.filter((e) => e.type === "dir" && this.expanded.has(join(dir, e.name))).map((e) => load(join(dir, e.name))));
      } catch {
        this.expanded.delete(dir);
      }
    };
    await load("/");
    this.flatten();
    this.render();
  }

  /** Show `path` selected, expanding its parents. */
  async reveal(path: string): Promise<void> {
    for (let d = dirname(path); d !== "/"; d = dirname(d)) this.expanded.add(d);
    await this.refresh();
    this.selected = new Set([path]);
    this.anchor = this.focusPath = path;
    this.render();
  }

  private flatten(): void {
    const rows: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of this.children.get(dir) ?? []) {
        const path = join(dir, e.name);
        rows.push({ path, name: e.name, type: e.type, depth });
        if (e.type === "dir" && this.expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk("/", 0);
    this.rows = rows;
    const visible = new Set(rows.map((r) => r.path));
    for (const p of this.selected) if (!visible.has(p)) this.selected.delete(p);
  }

  private render(): void {
    if (!this.rows.length) {
      this.list.innerHTML = `<div class="ex-empty">No files yet.<br>Create one with <b>+ File</b>.</div>`;
      return;
    }
    this.list.innerHTML = this.rows
      .map((r, i) => {
        const open = r.type === "dir" && this.expanded.has(r.path);
        const cls = ["ex-row", r.type, this.selected.has(r.path) ? "sel" : "", this.focusPath === r.path ? "focus" : ""].join(" ");
        const icon = r.type === "dir" ? (open ? "▾" : "▸") : "·";
        return `<div class="${cls}" role="treeitem" data-i="${i}" style="--depth:${r.depth}" aria-selected="${this.selected.has(r.path)}"${r.type === "dir" ? ` aria-expanded="${open}"` : ""}><span class="ex-icon">${icon}</span><span class="ex-name"></span></div>`;
      })
      .join("");
    this.list.querySelectorAll<HTMLElement>(".ex-name").forEach((el, i) => (el.textContent = this.rows[i].name));
    this.list.querySelector(".focus")?.scrollIntoView({ block: "nearest" });
  }

  private rowAt(target: EventTarget | null): Row | null {
    const el = (target as HTMLElement | null)?.closest?.(".ex-row") as HTMLElement | null;
    return el ? this.rows[Number(el.dataset.i)] ?? null : null;
  }

  private rowAtPoint(x: number, y: number): Row | null {
    const el = document.elementFromPoint(x, y);
    if (el) return this.rowAt(el);
    return null;
  }

  /** The directory new items go in: the focused folder, or the focused file's folder. */
  private targetDir(): string {
    const r = this.rows.find((r) => r.path === this.focusPath);
    if (!r) return "/";
    return r.type === "dir" ? r.path : dirname(r.path);
  }

  // ----- selection -------------------------------------------------------------------

  private selectRange(to: Row): void {
    const from = this.rows.findIndex((r) => r.path === (this.anchor ?? to.path));
    const end = this.rows.indexOf(to);
    const [a, b] = from < end ? [from, end] : [end, from];
    this.selected = new Set(this.rows.slice(Math.max(0, a), b + 1).map((r) => r.path));
    this.focusPath = to.path;
  }

  /** The common pointer / tap logic, shared by every input device. */
  private press(row: Row, extend: boolean, toggle: boolean): void {
    if (extend) {
      this.selectRange(row);
    } else if (toggle) {
      if (this.selected.has(row.path)) this.selected.delete(row.path);
      else this.selected.add(row.path);
      this.anchor = this.focusPath = row.path;
    } else {
      this.selected = new Set([row.path]);
      this.anchor = this.focusPath = row.path;
      this.activate(row);
    }
    this.render();
  }

  private activate(row: Row): void {
    if (row.type === "dir") void this.toggleDir(row.path);
    else this.host.open(row.path);
  }

  private async toggleDir(path: string, open = !this.expanded.has(path)): Promise<void> {
    if (open) this.expanded.add(path);
    else for (const p of [...this.expanded]) if (within(p, path)) this.expanded.delete(p);
    await this.refresh();
  }

  private bindPointer(): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "none" | "pending" | "drag" | "scroll" = "none";
    let start = { x: 0, y: 0, row: null as Row | null };
    let lastY = 0;

    this.list.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      const row = this.rowAt(e.target);
      if (e.pointerType === "mouse") {
        this.focus();
        if (!row) {
          this.selected.clear();
          this.render();
          return;
        }
        e.preventDefault();
        this.press(row, e.shiftKey, e.ctrlKey || e.metaKey);
        mode = "drag";
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        capture(this.list, e.pointerId);
        return;
      }
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(this.list, e.pointerId);
      if (pointers.size >= 2) {
        mode = "scroll";
        lastY = [...pointers.values()].reduce((a, p) => a + p.y, 0) / pointers.size;
      } else {
        mode = "pending";
        start = { x: e.clientX, y: e.clientY, row };
      }
    });
    this.list.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "pending" && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) {
        // One-finger drag selects a range from the anchor, like ⇧+drag.
        mode = "drag";
        if (!this.anchor && start.row) this.anchor = start.row.path;
      }
      if (mode === "drag" && (e.pointerType !== "mouse" || e.buttons & 1)) {
        const row = this.rowAtPoint(e.clientX, e.clientY);
        if (row && row.path !== this.focusPath) {
          this.selectRange(row);
          this.render();
        }
      } else if (mode === "scroll") {
        const y = [...pointers.values()].reduce((a, p) => a + p.y, 0) / pointers.size;
        this.list.scrollTop += lastY - y;
        lastY = y;
      }
    });
    const end = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (mode === "pending" && e.type === "pointerup") {
        const row = start.row;
        if (row) this.press(row, false, false);
        else {
          this.selected.clear();
          this.render();
        }
      }
      if (!pointers.size) mode = "none";
    };
    this.list.addEventListener("pointerup", end);
    this.list.addEventListener("pointercancel", end);
    this.list.addEventListener("longpress", () => {
      pointers.clear();
      mode = "none";
    });
  }

  private bindKeys(): void {
    this.list.addEventListener("keydown", (e) => {
      const i = this.rows.findIndex((r) => r.path === this.focusPath);
      const row = this.rows[i];
      const go = (j: number) => {
        const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))];
        if (!r) return;
        if (e.shiftKey) this.selectRange(r);
        else {
          this.selected = new Set([r.path]);
          this.anchor = this.focusPath = r.path;
        }
        this.render();
      };
      switch (e.key) {
        case "ArrowDown":
          go(i + 1);
          break;
        case "ArrowUp":
          go(i < 0 ? 0 : i - 1);
          break;
        case "Home":
          go(0);
          break;
        case "End":
          go(this.rows.length - 1);
          break;
        case "ArrowRight":
          if (row?.type === "dir" && !this.expanded.has(row.path)) void this.toggleDir(row.path, true);
          break;
        case "ArrowLeft":
          if (row?.type === "dir" && this.expanded.has(row.path)) void this.toggleDir(row.path, false);
          else if (row) {
            const parent = this.rows.findIndex((r) => r.path === dirname(row.path));
            if (parent >= 0) go(parent);
          }
          break;
        case "Enter":
          if (row) this.activate(row);
          break;
        case "F2":
          if (row) void this.rename(row);
          break;
        case "Delete":
        case "Backspace":
          void this.removeSelected();
          break;
        case "a":
          if (!(e.ctrlKey || e.metaKey)) return;
          this.selected = new Set(this.rows.map((r) => r.path));
          this.render();
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  private bindDrop(): void {
    this.list.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        this.list.classList.add("drop");
      }
    });
    this.list.addEventListener("dragleave", () => this.list.classList.remove("drop"));
    this.list.addEventListener("drop", (e) => {
      e.preventDefault();
      this.list.classList.remove("drop");
      const row = this.rowAt(e.target);
      const dir = row ? (row.type === "dir" ? row.path : dirname(row.path)) : "/";
      void this.upload(dir, [...(e.dataTransfer?.files ?? [])]);
    });
  }

  // ----- actions -----------------------------------------------------------------

  private fs(): FileSystem {
    const fs = this.host.fs();
    if (!fs) throw new Error("no workspace open");
    return fs;
  }

  private async guard(f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (e) {
      this.host.error((e as Error).message);
    }
  }

  /** zencode creates the file first, then opens it; names are always the user's. */
  async newFile(dir: string): Promise<void> {
    const name = await ask(`New file in ${dir}`, "", "Create");
    if (!name) return;
    await this.guard(async () => {
      const p = join(dir, name);
      if (await this.fs().stat(p)) throw new Error(`${p} already exists`);
      await this.fs().writeFile(p, "");
      await this.reveal(p);
      this.host.open(p);
    });
  }

  async newFolder(dir: string): Promise<void> {
    const name = await ask(`New folder in ${dir}`, "", "Create");
    if (!name) return;
    await this.guard(async () => {
      const p = join(dir, name);
      if (await this.fs().stat(p)) throw new Error(`${p} already exists`);
      await this.fs().mkdir(p);
      this.expanded.add(p);
      await this.reveal(p);
    });
  }

  private async rename(row: Row): Promise<void> {
    const name = await ask(`Rename ${row.path}`, row.name, "Rename", row.type === "file");
    if (!name || name === row.name) return;
    await this.guard(async () => {
      const to = join(dirname(row.path), name);
      await this.fs().rename(row.path, to);
      this.host.renamed(row.path, to);
      await this.reveal(to);
    });
  }

  private async removeSelected(): Promise<void> {
    const paths = [...this.selected].filter((p, _, all) => !all.some((q) => q !== p && within(p, q)));
    if (!paths.length) return;
    const what = paths.length === 1 ? paths[0] : `${paths.length} items`;
    if (!(await confirm(`Delete ${what}? This can't be undone.`, "Delete", true))) return;
    await this.guard(async () => {
      for (const p of paths) {
        await this.fs().remove(p);
        this.host.removed(p);
      }
      this.selected.clear();
      await this.refresh();
    });
  }

  private async duplicate(row: Row): Promise<void> {
    await this.guard(async () => {
      const dot = row.name.lastIndexOf(".");
      const stem = dot > 0 ? row.name.slice(0, dot) : row.name;
      const ext = dot > 0 ? row.name.slice(dot) : "";
      let p = "";
      for (let n = 1; ; n++) {
        p = join(dirname(row.path), `${stem} copy${n > 1 ? " " + n : ""}${ext}`);
        if (!(await this.fs().stat(p))) break;
      }
      await this.fs().writeBytes(p, await this.fs().readBytes(row.path));
      await this.reveal(p);
    });
  }

  private async upload(dir: string, files: File[]): Promise<void> {
    if (!files.length) return;
    await this.guard(async () => {
      for (const f of files) await this.fs().writeBytes(join(dir, f.name), new Uint8Array(await f.arrayBuffer()));
      this.expanded.add(dir);
      await this.refresh();
    });
  }

  private async download(paths: string[]): Promise<void> {
    await this.guard(async () => {
      const fs = this.fs();
      if (paths.length === 1) {
        const st = await fs.stat(paths[0]);
        if (st?.type === "file") {
          downloadBlob(new Blob([(await fs.readBytes(paths[0])) as BlobPart]), basename(paths[0]));
          return;
        }
      }
      const name = paths.length === 1 ? basename(paths[0]) || this.host.workspaceName() : this.host.workspaceName();
      const files = [];
      for (const p of paths) {
        const st = await fs.stat(p);
        if (st?.type === "dir") files.push(...(await collect(fs, p, paths.length === 1 ? name : `${name}/${basename(p)}`)));
        else if (st) files.push({ name: `${name}/${basename(p)}`, data: await fs.readBytes(p), mtime: st.mtime });
      }
      downloadBlob(zip(files), `${name}.zip`);
    });
  }

  /** Download the whole workspace as a .zip. */
  downloadWorkspace(): Promise<void> {
    return this.guard(async () => {
      const name = this.host.workspaceName();
      downloadBlob(zip(await collect(this.fs(), "/", name)), `${name}.zip`);
    });
  }

  // ----- menus ---------------------------------------------------------------------

  private backgroundMenu(): MenuItem[] {
    return [
      { label: "New File…", action: () => void this.newFile("/") },
      { label: "New Folder…", action: () => void this.newFolder("/") },
      { label: "Upload Files…", action: () => this.pickUpload("/") },
      "separator",
      { label: "Download Workspace (.zip)", action: () => void this.downloadWorkspace() },
      { label: "Refresh", action: () => void this.refresh() },
    ];
  }

  private pickUpload(dir: string): void {
    this.uploadDir = dir;
    this.uploadInput.click();
  }

  private menuFor(target: HTMLElement): MenuItem[] {
    const row = this.rowAt(target);
    if (!row) {
      this.selected.clear();
      this.render();
      return this.backgroundMenu();
    }
    // Right-clicking outside the selection selects just that item first.
    if (!this.selected.has(row.path)) {
      this.selected = new Set([row.path]);
      this.anchor = this.focusPath = row.path;
      this.render();
    }
    const many = this.selected.size > 1;
    const paths = [...this.selected];
    if (many) {
      return [
        { label: `Download ${paths.length} Items (.zip)`, action: () => void this.download(paths) },
        "separator",
        { label: `Delete ${paths.length} Items…`, action: () => void this.removeSelected(), danger: true },
      ];
    }
    const items: MenuItem[] = [];
    if (row.type === "file") {
      items.push({ label: "Open", hint: "Enter", action: () => this.host.open(row.path) });
      const viewers = this.host.openWith(row.path);
      if (viewers.length) {
        items.push({ label: "Open in zencode", action: () => this.host.open(row.path, "zencode") });
        for (const v of viewers) items.push({ label: `Open With ${v.name}`, action: () => this.host.open(row.path, v.id) });
      }
      if (this.host.canRun(row.path)) items.push({ label: "Run in Terminal", action: () => this.host.run(row.path) });
      items.push("separator");
    }
    const dir = row.type === "dir" ? row.path : dirname(row.path);
    items.push(
      { label: "New File…", action: () => void this.newFile(dir) },
      { label: "New Folder…", action: () => void this.newFolder(dir) },
      { label: "Upload Files…", action: () => this.pickUpload(dir) },
      "separator",
      { label: "Rename…", hint: "F2", action: () => void this.rename(row) },
    );
    if (row.type === "file") items.push({ label: "Duplicate", action: () => void this.duplicate(row) });
    items.push(
      { label: row.type === "dir" ? "Download Folder (.zip)" : "Download", action: () => void this.download([row.path]) },
      { label: "Copy Path", action: () => void navigator.clipboard?.writeText(row.path).catch(() => {}) },
      "separator",
      { label: "Delete…", hint: "⌫", action: () => void this.removeSelected(), danger: true },
    );
    return items;
  }
}

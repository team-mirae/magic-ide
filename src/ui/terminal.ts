// The VENV terminal: a small shell over the workspace's virtual
// filesystem, since there is no host shell to talk to. `run <file>` hands
// the file to a runner plugin (docs/PLUGINS.md).
//
// Input goes through the shared InputSink, so the line editor works with
// every IME and soft keyboard the editor does. The key bar adds ⌃C, ⌃D,
// Tab and history keys for keyboards that lack them.
//
// Touch: tap to type, one-finger drag selects output like ⇧+drag, two
// fingers scroll, long press opens the menu.

import { basename, extname, join, resolve } from "../fs/path";
import type { FileSystem } from "../fs/types";
import type { PluginRegistry } from "../plugins/registry";
import * as letterblock from "../zencode/letterblock";
import { codeIndex, graphemeCount, graphemes } from "../zencode/text";
import { AnsiParser } from "./ansi";
import { InputSink, type Edit } from "./input";
import { key, type Key } from "./keys";
import { capture, contextMenu, type MenuItem } from "./menu";

const SCROLLBACK = 5000;
const TAP_SLOP = 8;

export interface TerminalHost {
  fs(): FileSystem | null;
  plugins: PluginRegistry;
  open(path: string): void;
  /** The workspace changed under the explorer. */
  changed(): void;
  workspaces(args: string[], out: (s: string) => void): Promise<void>;
}

interface Pending {
  prompt: string;
  resolve: (line: string | null) => void;
}

/** Split a command line, honouring quotes and backslashes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export class Terminal {
  readonly root: HTMLElement;
  private out: HTMLElement;
  private lineEl: HTMLElement;
  readonly input: InputSink;
  private ansi = new AnsiParser();

  cwd = "/";
  private line = "";
  /** Cursor, as a grapheme index into `line`. */
  private cur = 0;
  private preedit = "";
  private history: string[] = [];
  private histIdx = 0;
  private draft = "";
  private busy = false;
  private pending: Pending | null = null;
  private abort: AbortController | null = null;
  /** Lines typed (or pasted) while a command was busy, fed to it or the shell in order. */
  private queue: string[] = [];
  /** A Tab completion still reading the filesystem; Enter waits for it. */
  private completing: Promise<void> | null = null;

  constructor(private host: TerminalHost) {
    this.root = document.createElement("div");
    this.root.className = "term";
    this.root.innerHTML = `<div class="term-scroll"><div class="term-out"></div><div class="term-line"></div></div>`;
    this.out = this.root.querySelector(".term-out")!;
    this.lineEl = this.root.querySelector(".term-line")!;
    this.input = new InputSink({
      context: () => {
        const at = codeIndex(this.line, this.cur);
        return { before: this.line.slice(0, at), after: this.line.slice(at) };
      },
      apply: (e) => this.onInput(e),
      key: (k) => this.onKey(k),
      preedit: (t) => {
        this.preedit = t;
        this.renderLine();
      },
    });
    this.input.el.classList.add("term-input");
    this.root.appendChild(this.input.el);
    this.input.el.addEventListener("paste", (e) => {
      e.preventDefault();
      this.typeText(e.clipboardData?.getData("text/plain") ?? "");
    });
    this.input.el.addEventListener("focus", () => this.root.classList.add("focused"));
    this.input.el.addEventListener("blur", () => this.root.classList.remove("focused"));
    this.bindPointer();
    contextMenu(this.root, () => this.menu());
    this.write("\x1b[1;35mmagic-ide\x1b[0m VENV terminal. Type \x1b[1mhelp\x1b[0m for commands.\n");
    this.renderLine();
  }

  /** Extra keys for the on-screen key bar while the terminal has focus. */
  static readonly extraKeys: { label: string; key: Key }[] = [
    { label: "⌃C", key: key("c", { ctrl: true }) },
    { label: "⌃D", key: key("d", { ctrl: true }) },
    { label: "⌃L", key: key("l", { ctrl: true }) },
  ];

  focus(): void {
    this.input.focus();
  }

  /** The text currently on the input line, for tests. */
  get currentLine(): string {
    return this.line;
  }

  get output(): string {
    return this.out.textContent ?? "";
  }

  // ----- output --------------------------------------------------------------------

  write(text: string, cls = ""): void {
    const scroller = this.root.firstElementChild as HTMLElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    for (const run of this.ansi.parse(text)) {
      const span = document.createElement("span");
      span.className = [run.cls, cls].filter(Boolean).join(" ");
      span.textContent = run.text;
      this.out.appendChild(span);
    }
    while (this.out.childNodes.length > SCROLLBACK) this.out.firstChild!.remove();
    if (atBottom) this.scrollToEnd();
  }

  private scrollToEnd(): void {
    const scroller = this.root.firstElementChild as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
  }

  clear(): void {
    this.out.textContent = "";
  }

  private promptText(): string {
    if (this.pending) return this.pending.prompt;
    if (this.busy) return "";
    return `${this.cwd} $ `;
  }

  private renderLine(): void {
    const gs = graphemes(this.line);
    const before = gs.slice(0, this.cur).join("");
    const at = gs[this.cur] ?? " ";
    const after = gs.slice(this.cur + 1).join("");
    const p = this.promptText();
    this.lineEl.hidden = this.busy && !this.pending;
    this.lineEl.innerHTML = `<span class="term-prompt"></span><span></span><span class="term-preedit"></span><span class="term-cursor"></span><span></span>`;
    const [pe, be, pre, ce, ae] = Array.from(this.lineEl.children) as HTMLElement[];
    pe.textContent = p;
    be.textContent = before;
    pre.textContent = this.preedit;
    pre.hidden = !this.preedit;
    ce.textContent = at;
    ae.textContent = after;
    this.scrollToEnd();
  }

  // ----- input ---------------------------------------------------------------------

  private setLine(line: string, cur = graphemeCount(line)): void {
    this.line = line;
    this.cur = cur;
    this.renderLine();
  }

  private insertText(s: string): void {
    const gs = graphemes(this.line);
    this.setLine(gs.slice(0, this.cur).join("") + s + gs.slice(this.cur).join(""), this.cur + graphemeCount(s));
  }

  /** Text arriving as a block: each newline submits the line so far. */
  private typeText(text: string): void {
    const parts = text.replace(/\r\n?/g, "\n").split("\n");
    this.insertText(parts[0]);
    for (const part of parts.slice(1)) {
      this.submit();
      this.insertText(part);
    }
  }

  /** Typing while a command runs is typeahead: the line is kept, and Enter queues it. */
  private onInput(e: Edit): void {
    const gs = graphemes(this.line);
    const start = Math.max(0, this.cur - e.deleteBefore);
    const end = Math.min(gs.length, this.cur + e.deleteAfter);
    this.line = gs.slice(0, start).join("") + gs.slice(end).join("");
    this.cur = start;
    this.typeText(e.insert);
    this.renderLine();
  }

  private onKey(k: Key): boolean {
    const { ctrl, alt, meta } = k;
    const c = k.key;
    if (ctrl && c === "c") {
      if (this.abort) {
        this.write("^C\n");
        this.abort.abort();
      } else {
        this.write(`${this.promptText()}${this.line}^C\n`);
        this.setLine("");
      }
      this.queue = [];
      return true;
    }
    if (ctrl && c === "l") {
      this.clear();
      return true;
    }
    if (ctrl && c === "d") {
      if (this.pending && !this.line) {
        const p = this.pending;
        this.pending = null;
        this.write(`${p.prompt}\n`);
        p.resolve(null);
        this.renderLine();
      }
      return true;
    }
    const gs = graphemes(this.line);
    if (meta && c === "ArrowLeft") return this.setLine(this.line, 0), true;
    if (meta && c === "ArrowRight") return this.setLine(this.line, gs.length), true;
    if ((ctrl && c === "a") || c === "Home") return this.setLine(this.line, 0), true;
    if ((ctrl && c === "e") || c === "End") return this.setLine(this.line, gs.length), true;
    if (ctrl && c === "u") return this.setLine(gs.slice(this.cur).join(""), 0), true;
    if (ctrl && c === "k") return this.setLine(gs.slice(0, this.cur).join(""), this.cur), true;
    if ((ctrl || alt) && (c === "Backspace" || c === "h" || c === "w")) {
      const to = letterblock.left(this.line, this.cur);
      return this.setLine(gs.slice(0, to).join("") + gs.slice(this.cur).join(""), to), true;
    }
    if ((ctrl || alt) && c === "ArrowLeft") return this.setLine(this.line, letterblock.left(this.line, this.cur)), true;
    if ((ctrl || alt) && c === "ArrowRight") return this.setLine(this.line, letterblock.right(this.line, this.cur)), true;
    if (ctrl || alt || meta) return false;
    switch (c) {
      case "Enter":
        if (this.completing) void this.completing.then(() => this.submit());
        else this.submit();
        return true;
      case "Backspace":
        if (this.cur > 0) this.setLine(gs.slice(0, this.cur - 1).join("") + gs.slice(this.cur).join(""), this.cur - 1);
        return true;
      case "Delete":
        if (this.cur < gs.length) this.setLine(gs.slice(0, this.cur).join("") + gs.slice(this.cur + 1).join(""), this.cur);
        return true;
      case "ArrowLeft":
        return this.setLine(this.line, Math.max(0, this.cur - 1)), true;
      case "ArrowRight":
        return this.setLine(this.line, Math.min(gs.length, this.cur + 1)), true;
      case "ArrowUp":
        return this.recall(-1), true;
      case "ArrowDown":
        return this.recall(1), true;
      case "Tab": {
        const p = (this.completing ?? Promise.resolve()).then(() => this.complete());
        this.completing = p;
        void p.finally(() => {
          if (this.completing === p) this.completing = null;
        });
        return true;
      }
      case "Escape":
        return true;
    }
    if ([...c].length === 1) return this.insertText(c), true;
    return false;
  }

  private recall(dir: number): void {
    if (this.pending || !this.history.length) return;
    if (this.histIdx === this.history.length) this.draft = this.line;
    this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx + dir));
    this.setLine(this.histIdx === this.history.length ? this.draft : this.history[this.histIdx]);
  }

  private submit(): void {
    const line = this.line;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.write(`${p.prompt}${line}\n`, "term-echo");
      this.setLine("");
      p.resolve(line);
      return;
    }
    if (this.busy) {
      this.queue.push(line);
      this.setLine("");
      return;
    }
    this.write(`${this.promptText()}${line}\n`, "term-echo");
    this.setLine("");
    if (line.trim()) {
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      this.histIdx = this.history.length;
      void this.execute(line);
    }
  }

  /** Run a command line, for the shell itself and for buttons elsewhere in the app. */
  async execute(line: string): Promise<void> {
    this.busy = true;
    this.renderLine();
    try {
      await this.command(tokenize(line));
    } catch (e) {
      this.write(`${(e as Error).message}\n`, "term-err");
    } finally {
      this.busy = false;
      this.abort = null;
      this.renderLine();
    }
    const next = this.queue.shift();
    if (next !== undefined) {
      this.setLine(next);
      this.submit();
    }
  }

  private readLine(prompt = ""): Promise<string | null> {
    return new Promise((resolve) => {
      this.pending = { prompt, resolve };
      const queued = this.queue.shift();
      if (queued !== undefined) {
        this.setLine(queued);
        this.submit();
      } else {
        this.renderLine();
      }
    });
  }

  private async complete(): Promise<void> {
    const fs = this.host.fs();
    if (!fs || this.pending) return;
    const before = graphemes(this.line).slice(0, this.cur).join("");
    const m = /(\S*)$/.exec(before)!;
    const word = m[1];
    const isCmd = !before.slice(0, before.length - word.length).trim();
    let options: string[];
    if (isCmd && !word.includes("/")) {
      options = Object.keys(COMMANDS).filter((c) => c.startsWith(word));
    } else {
      const dir = word.includes("/") ? word.slice(0, word.lastIndexOf("/") + 1) : "";
      const base = word.slice(dir.length);
      try {
        const entries = await fs.readdir(resolve(this.cwd, dir || "."));
        options = entries.filter((e) => e.name.startsWith(base)).map((e) => dir + e.name + (e.type === "dir" ? "/" : ""));
      } catch {
        options = [];
      }
    }
    if (!options.length) return;
    let common = options[0];
    for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1);
    if (common.length > word.length) {
      const fill = common.slice(word.length) + (options.length === 1 && !common.endsWith("/") ? " " : "");
      this.insertText(fill);
    } else if (options.length > 1) {
      this.write(`${this.promptText()}${this.line}\n${options.join("  ")}\n`);
      this.renderLine();
    }
  }

  // ----- commands -------------------------------------------------------------------

  private async command(argv: string[]): Promise<void> {
    if (!argv.length) return;
    // `> file` and `>> file` redirect a command's output into a file.
    let redirect: { path: string; append: boolean } | null = null;
    const r = argv.findIndex((a) => a === ">" || a === ">>");
    if (r >= 0) {
      if (!argv[r + 1]) throw new Error("syntax error: missing file after redirect");
      redirect = { path: resolve(this.cwd, argv[r + 1]), append: argv[r] === ">>" };
      argv = argv.slice(0, r);
    }
    const [name, ...args] = argv;
    let cmd = COMMANDS[name];
    // `./file.js` and `file.js` run the file, like an executable.
    if (!cmd && (name.startsWith("./") || name.startsWith("/") || this.host.plugins.runnerFor(name))) {
      cmd = COMMANDS.run;
      args.unshift(name);
    }
    if (!cmd) throw new Error(`${name}: command not found. Type help for commands.`);
    let captured = "";
    const out = redirect ? (s: string) => void (captured += s) : (s: string) => this.write(s);
    await cmd.run(this, args, out);
    if (redirect) {
      const fs = this.needFs();
      const prev = redirect.append ? await fs.readFile(redirect.path).catch(() => "") : "";
      await fs.writeFile(redirect.path, prev + captured);
      this.host.changed();
    }
  }

  needFs(): FileSystem {
    const fs = this.host.fs();
    if (!fs) throw new Error("no workspace open");
    return fs;
  }

  /** Run a file with its runner plugin. */
  async run(entryArg: string, args: string[], out: (s: string) => void): Promise<number> {
    const fs = this.needFs();
    const entry = resolve(this.cwd, entryArg);
    const runner = this.host.plugins.runnerFor(entry);
    if (!runner) {
      const ext = extname(entry) || basename(entry);
      throw new Error(`run: no runner for ${ext}. Install one with: plugin add <url>`);
    }
    const source = await fs.readFile(entry);
    await this.host.plugins.prepare(runner, (t) => this.write(t, "term-dim"));
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let code: number;
    try {
      code = await runner.run(
        {
          entry,
          source,
          args,
          cwd: this.cwd,
          env: { HOME: "/", PWD: this.cwd },
          fs: {
            readFile: (p) => fs.readFile(resolve(this.cwd, p)),
            writeFile: async (p, d) => {
              await fs.writeFile(resolve(this.cwd, p), d);
              this.host.changed();
            },
            readdir: (p) => fs.readdir(resolve(this.cwd, p)),
            stat: (p) => fs.stat(resolve(this.cwd, p)),
            mkdir: async (p) => {
              await fs.mkdir(resolve(this.cwd, p));
              this.host.changed();
            },
            remove: async (p) => {
              await fs.remove(resolve(this.cwd, p));
              this.host.changed();
            },
          },
        },
        {
          stdout: (t) => !signal.aborted && out(t),
          stderr: (t) => !signal.aborted && this.write(t, "term-err"),
          readLine: (p) => (signal.aborted ? Promise.resolve(null) : this.readLine(p)),
          signal,
        },
      );
    } finally {
      if (this.pending) {
        this.pending.resolve(null);
        this.pending = null;
      }
    }
    if (code !== 0) this.write(`[exit ${code}]\n`, "term-dim");
    return code;
  }

  // ----- pointer ---------------------------------------------------------------------

  private bindPointer(): void {
    const scroller = this.root.firstElementChild as HTMLElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "none" | "pending" | "select" | "scroll" = "none";
    let start = { x: 0, y: 0 };
    let lastY = 0;
    const caret = (x: number, y: number): { node: Node; offset: number } | null => {
      const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
      const p = doc.caretPositionFromPoint?.(x, y);
      if (p) return { node: p.offsetNode, offset: p.offset };
      const r = document.caretRangeFromPoint?.(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    };
    let anchor: { node: Node; offset: number } | null = null;

    this.root.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") {
        // Mouse selection is native; a click without a drag focuses the input.
        start = { x: e.clientX, y: e.clientY };
        return;
      }
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(this.root, e.pointerId);
      if (pointers.size >= 2) {
        mode = "scroll";
        lastY = [...pointers.values()].reduce((a, p) => a + p.y, 0) / pointers.size;
      } else {
        mode = "pending";
        start = { x: e.clientX, y: e.clientY };
      }
    });
    this.root.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "pending" && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) {
        // One-finger drag selects like ⇧+drag: from the existing selection's anchor, or from where it began.
        const sel = getSelection();
        anchor = sel && sel.rangeCount && this.root.contains(sel.anchorNode) && !sel.isCollapsed
          ? { node: sel.anchorNode!, offset: sel.anchorOffset }
          : caret(start.x, start.y);
        mode = "select";
      }
      if (mode === "select" && anchor) {
        const focus = caret(e.clientX, e.clientY);
        if (focus) getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      } else if (mode === "scroll") {
        const y = [...pointers.values()].reduce((a, p) => a + p.y, 0) / pointers.size;
        scroller.scrollTop += lastY - y;
        lastY = y;
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        if (e.type === "pointerup" && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4 && getSelection()?.isCollapsed !== false) {
          this.focus();
        }
        return;
      }
      if (!pointers.delete(e.pointerId)) return;
      if (mode === "pending" && e.type === "pointerup") {
        getSelection()?.removeAllRanges();
        this.focus();
      }
      if (!pointers.size) mode = "none";
    };
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);
    this.root.addEventListener("longpress", () => {
      pointers.clear();
      mode = "none";
    });
  }

  private menu(): MenuItem[] {
    const sel = getSelection();
    const selected = sel && !sel.isCollapsed && this.root.contains(sel.anchorNode) ? sel.toString() : "";
    const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});
    return [
      { label: "Copy", hint: "⌘C", action: () => copy(selected), disabled: !selected },
      { label: "Copy All Output", action: () => copy(this.output) },
      {
        label: "Paste",
        hint: "⌘V",
        action: async () => {
          try {
            this.typeText(await navigator.clipboard.readText());
          } catch {
            this.write("The browser didn't allow reading the clipboard.\n", "term-err");
          }
          this.focus();
        },
      },
      "separator",
      { label: "Interrupt", hint: "⌃C", action: () => this.onKey(key("c", { ctrl: true })) },
      { label: "Clear", hint: "⌃L", action: () => this.clear() },
    ];
  }
}

// ----- the shell's commands ----------------------------------------------------------

interface Command {
  usage: string;
  help: string;
  run(t: Terminal, args: string[], out: (s: string) => void): Promise<void>;
}

function flags(args: string[]): { flags: Set<string>; rest: string[] } {
  const f = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) for (const c of a.slice(1)) f.add(c);
    else rest.push(a);
  }
  return { flags: f, rest };
}

const COMMANDS: Record<string, Command> = {
  help: {
    usage: "help",
    help: "list commands",
    async run(_t, _a, out) {
      const w = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
      out(Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(w)}  ${c.help}`).join("\n") + "\n");
      out("\nKeys: Tab completes, ↑↓ history, ⌃C interrupts, ⌃L clears. `> file` redirects output.\n");
    },
  },
  pwd: {
    usage: "pwd",
    help: "print the working directory",
    async run(t, _a, out) {
      out(t.cwd + "\n");
    },
  },
  cd: {
    usage: "cd [dir]",
    help: "change directory",
    async run(t, [dir = "/"]) {
      const p = resolve(t.cwd, dir);
      const st = await t.needFs().stat(p);
      if (!st) throw new Error(`cd: ${dir}: no such directory`);
      if (st.type !== "dir") throw new Error(`cd: ${dir}: not a directory`);
      t.cwd = p;
    },
  },
  ls: {
    usage: "ls [-l] [path]",
    help: "list a directory",
    async run(t, args, out) {
      const { flags: f, rest } = flags(args);
      const fs = t.needFs();
      const p = resolve(t.cwd, rest[0] ?? ".");
      const st = await fs.stat(p);
      if (!st) throw new Error(`ls: ${rest[0]}: no such file or directory`);
      if (st.type === "file") return out(basename(p) + "\n");
      const entries = await fs.readdir(p);
      if (f.has("l")) {
        for (const e of entries) {
          const s = await fs.stat(join(p, e.name));
          const d = new Date(s?.mtime ?? 0);
          const pad = (n: number) => String(n).padStart(2, "0");
          const date = s ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
          out(`${e.type === "dir" ? "d" : "-"} ${String(s?.size ?? 0).padStart(8)} ${date}  ${e.name}${e.type === "dir" ? "/" : ""}\n`);
        }
      } else if (entries.length) {
        out(entries.map((e) => (e.type === "dir" ? `\x1b[1;34m${e.name}/\x1b[0m` : e.name)).join("  ") + "\n");
      }
    },
  },
  cat: {
    usage: "cat <file>…",
    help: "print files",
    async run(t, args, out) {
      for (const a of args) {
        const text = await t.needFs().readFile(resolve(t.cwd, a));
        out(text.endsWith("\n") || !text ? text : text + "\n");
      }
    },
  },
  echo: {
    usage: "echo [text]…",
    help: "print text",
    async run(_t, args, out) {
      out(args.join(" ") + "\n");
    },
  },
  touch: {
    usage: "touch <file>…",
    help: "create empty files",
    async run(t, args) {
      const fs = t.needFs();
      for (const a of args) {
        const p = resolve(t.cwd, a);
        if (!(await fs.stat(p))) await fs.writeFile(p, "");
      }
      hostChanged(t);
    },
  },
  mkdir: {
    usage: "mkdir <dir>…",
    help: "create directories (and their parents)",
    async run(t, args) {
      for (const a of args) await t.needFs().mkdir(resolve(t.cwd, a));
      hostChanged(t);
    },
  },
  rm: {
    usage: "rm [-r] <path>…",
    help: "remove files, or directories with -r",
    async run(t, args) {
      const { flags: f, rest } = flags(args);
      const fs = t.needFs();
      for (const a of rest) {
        const p = resolve(t.cwd, a);
        const st = await fs.stat(p);
        if (!st) throw new Error(`rm: ${a}: no such file or directory`);
        if (st.type === "dir" && !f.has("r")) throw new Error(`rm: ${a}: is a directory (use rm -r)`);
        await fs.remove(p);
      }
      hostChanged(t);
    },
  },
  mv: {
    usage: "mv <from> <to>",
    help: "move or rename",
    async run(t, [from, to]) {
      if (!from || !to) throw new Error("usage: mv <from> <to>");
      const fs = t.needFs();
      let dest = resolve(t.cwd, to);
      if ((await fs.stat(dest))?.type === "dir") dest = join(dest, basename(resolve(t.cwd, from)));
      await fs.rename(resolve(t.cwd, from), dest);
      hostChanged(t);
    },
  },
  cp: {
    usage: "cp <from> <to>",
    help: "copy a file",
    async run(t, [from, to]) {
      if (!from || !to) throw new Error("usage: cp <from> <to>");
      const fs = t.needFs();
      let dest = resolve(t.cwd, to);
      if ((await fs.stat(dest))?.type === "dir") dest = join(dest, basename(resolve(t.cwd, from)));
      await fs.writeFile(dest, await fs.readFile(resolve(t.cwd, from)));
      hostChanged(t);
    },
  },
  open: {
    usage: "open <file>",
    help: "open a file in the editor (created if missing)",
    async run(t, [file]) {
      if (!file) throw new Error("usage: open <file>");
      const fs = t.needFs();
      const p = resolve(t.cwd, file);
      if (!(await fs.stat(p))) {
        await fs.writeFile(p, "");
        hostChanged(t);
      }
      hostOf(t).open(p);
    },
  },
  run: {
    usage: "run <file> [args]…",
    help: "run a file with its runner plugin",
    async run(t, [file, ...args], out) {
      if (!file) throw new Error("usage: run <file> [args]…");
      await t.run(file, args, out);
    },
  },
  runners: {
    usage: "runners",
    help: "list code runners",
    async run(t, _a, out) {
      for (const r of hostOf(t).plugins.runners()) out(`  ${r.id.padEnd(14)} ${r.extensions.join(" ").padEnd(14)} ${r.name}\n`);
    },
  },
  plugin: {
    usage: "plugin [add <url> | rm <id>]",
    help: "list, install or remove plugin modules",
    async run(t, [sub, arg], out) {
      const reg = hostOf(t).plugins;
      if (sub === "add") {
        if (!arg) throw new Error("usage: plugin add <url>");
        const m = await reg.install(arg);
        out(`installed ${m.id}: ${m.highlighters?.length ?? 0} highlighter(s), ${m.runners?.length ?? 0} runner(s), ${m.viewers?.length ?? 0} viewer(s)\n`);
      } else if (sub === "rm") {
        if (!arg || !reg.uninstall(arg)) throw new Error(`plugin: ${arg ?? ""}: not installed`);
        out(`removed ${arg}\n`);
      } else {
        for (const m of reg.list()) {
          const parts = [
            ...(m.module.highlighters ?? []).map((h) => `hl:${h.id}`),
            ...(m.module.runners ?? []).map((r) => `run:${r.id}`),
            ...(m.module.viewers ?? []).map((v) => `view:${v.id}`),
          ];
          out(`  ${m.module.id.padEnd(14)} ${parts.join(" ")}${m.url ? `\n  ${"".padEnd(14)} ${m.url}` : ""}\n`);
        }
      }
    },
  },
  workspace: {
    usage: "workspace [new|use|rm <name>]",
    help: "list or switch workspaces",
    async run(t, args, out) {
      await hostOf(t).workspaces(args, out);
    },
  },
  clear: {
    usage: "clear",
    help: "clear the screen",
    async run(t) {
      t.clear();
    },
  },
};

function hostOf(t: Terminal): TerminalHost {
  return (t as unknown as { host: TerminalHost }).host;
}

function hostChanged(t: Terminal): void {
  hostOf(t).changed();
}


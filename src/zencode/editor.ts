// The zencode editor, for the browser. Behaviour and keys follow zencode
// (https://github.com/team-mirae/zencode, KEYBINDS.md); the screen is a
// character grid like zencode's terminal, so full-width 한글 and 日本語 take
// two cells and the cursor, scrolling and clicks line up the same way.
//
// Browser differences:
// - ⌃X closes the file's tab instead of exiting, ⌃O exports inside the
//   workspace, and ⌘S also saves on macOS.
// - ⌘C / ⌘X / ⌘V use the system clipboard, like a terminal's own copy and
//   paste; ⌃C / ⌃B / ⌃V use zencode's clipboard (also sent to the system one).
// - Touch: tap places the cursor (double / triple tap selects a
//   letterblock / line), one-finger drag extends the selection from the
//   cursor like ⇧+drag, two fingers or a drag on the line numbers scroll,
//   and a long press opens the context menu.

import type { Token } from "../plugins/api";
import { capture, contextMenu, type MenuItem } from "../ui/menu";
import { InputSink, type Edit } from "../ui/input";
import type { Key } from "../ui/keys";
import { posCmp, posEq, type Pos } from "./buffer";
import type { Doc } from "./doc";
import { EditKind, type Snapshot } from "./history";
import * as letterblock from "./letterblock";
import { Matcher, type Match } from "./search";
import { codeIndex, displayCol, gidxForCol, graphemeCount, graphemes, graphemeWidth, isControl, nearestBoundary, widthAt } from "./text";

const STATUS_TTL = 4000;
const MULTI_CLICK = 400;
const TAP_SLOP = 8;

type Action =
  | "close"
  | "save"
  | "export"
  | "find"
  | "findExact"
  | "help"
  | "copy"
  | "extract"
  | "paste"
  | "selectAll"
  | "undo"
  | "redo";

/** Always-visible shortcut bar, alternatives included, in zencode's order. */
const SHORTCUTS: [string, string, Action | null][] = [
  ["⌃X", "Close", "close"],
  ["⌃S", "Save", "save"],
  ["⌃O", "Export", "export"],
  ["⌃⇧X", "Force Close", null],
  ["⌃F", "Find", "find"],
  ["⌃G", "Find Exact", "findExact"],
  ["⌃/ F1", "Help", "help"],
  ["⌃←→/⌥←→", "Letterblock", null],
  ["⌃C", "Copy", "copy"],
  ["⌃B", "Extract", "extract"],
  ["⌃V", "Paste", "paste"],
  ["⌃/⌥ ⌫⌦", "Delete Letterblock", null],
  ["⌃A", "Select All", "selectAll"],
  ["⇧←→↑↓", "Select", null],
  ["⌃E/⌥E", "Undo", "undo"],
  ["⌃↑↓/⌥↑↓", "Move Line", null],
  ["⌃R/⌥R", "Redo", "redo"],
];

const HELP_LINES = [
  "A nano-style 全角 text editor",
  "",
  "⌃X   Close               ⌃⇧X  Close without saving",
  "⌃S   Save                ⌃O   Export to a new file",
  "⌃F   Find                ⌃G   Find exactly",
  "Tab  Next match          ⇧Tab Previous match",
  "⌃/   Help  (or F1)",
  "⌃C   Copy                ⌃B   Extract (cut)",
  "⌃V   Paste               ⌃A   Select all",
  "⌃E   Undo  (or ⌥E)       ⌃R   Redo  (or ⌥R)",
  "",
  "⇧ + any movement         Extend the selection",
  "⌃←→  ⌥←→  ⌥B ⌥F          Move by letterblock",
  "⌃⌫   ⌥⌫   ⌃H             Delete letterblock left",
  "⌃⌦   ⌥⌦   ⌥D             Delete letterblock right",
  "⌃↑↓  ⌥↑↓                 Move line up / down",
  "Home End PgUp PgDn       Line start / end, page",
  "⌃Home  ⌃End  ⌘↑↓         Top / bottom of file",
  "Esc                      Clear the selection",
  "",
  "Touch: drag extends the selection, two fingers scroll,",
  "long press opens the menu. ⌃ ⌥ ⇧ on the key bar stick.",
  "",
  "With nothing selected, ⌃C and ⌃B take the whole line.",
  "Letterblocks: words; 日本語 splits where the script",
  "changes; 한국어 splits off 조사 and 어미 (학교|에서는).",
  "Find ignores case, matches 초성 (ㅎㄱ finds 한국),",
  "and matches ひらがな to カタカナ.",
];

type PromptKind =
  | { t: "export" }
  | { t: "overwrite"; path: string }
  | { t: "search"; exact: boolean }
  | { t: "confirmClose" };

interface SearchState {
  exact: boolean;
  origin: [Pos, Pos | null];
  matches: Match[];
  byRow: Map<number, Match[]>;
  current: number | null;
}

interface Click {
  at: number;
  row: number;
  col: number;
  count: number;
  origin: Pos;
}

export interface EditorHost {
  /** Write the doc to its own path. */
  save(doc: Doc): Promise<void>;
  /** Resolve what was typed at the export prompt into a workspace path. */
  resolve(doc: Doc, input: string): string;
  exists(path: string): Promise<boolean>;
  write(path: string, text: string): Promise<void>;
  /** The user closed the doc (after confirming, if it had changes). */
  close(doc: Doc): void;
  /** Dirty state or path display changed. */
  changed(doc: Doc): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** "12 characters" or "3 lines" for status messages. */
function describe(text: string): string {
  const lines = text.split("\n").length;
  if (lines > 1) return `${lines} lines`;
  const n = graphemeCount(text);
  return `${n} character${plural(n)}`;
}

export class Editor {
  readonly root: HTMLElement;
  private view: HTMLElement;
  private rowsEl: HTMLElement;
  private cursorEl: HTMLElement;
  private preeditEl: HTMLElement;
  private statusEl: HTMLElement;
  private barEl: HTMLElement;
  private helpEl: HTMLElement;
  private emptyEl: HTMLElement;
  readonly input: InputSink;

  doc: Doc | null = null;
  private clip: { text: string; linewise: boolean } | null = null;
  private status: { text: string; error: boolean; until: number } | null = null;
  private statusTimer = 0;
  private prompt: { kind: PromptKind; input: HTMLInputElement | null } | null = null;
  private search: SearchState | null = null;
  private lastSearch = "";
  private showHelp = false;
  private followCursor = true;
  private lastClick: Click | null = null;
  private preedit = "";
  private frame = 0;

  private cw = 8;
  private lh = 18;
  private rows = 1;
  private cols = 1;
  private gutter = 4;

  constructor(private host: EditorHost) {
    this.root = document.createElement("div");
    this.root.className = "zen";
    this.root.innerHTML = `
      <div class="zen-view">
        <div class="zen-rows"></div>
        <div class="zen-preedit"></div>
        <div class="zen-cursor"></div>
        <div class="zen-empty">
          <div class="zen-empty-brand">zencode <span>젠코드</span> <span>ゼンコード</span></div>
          <p>Open a file from the explorer, or create one with <kbd>New File</kbd>.</p>
          <p>zencode never picks a file name for you.</p>
        </div>
        <span class="zen-probe">0000000000</span>
      </div>
      <div class="zen-status" aria-live="polite"></div>
      <div class="zen-bar"></div>
      <div class="zen-help" hidden></div>`;
    const $ = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.view = $(".zen-view");
    this.rowsEl = $(".zen-rows");
    this.cursorEl = $(".zen-cursor");
    this.preeditEl = $(".zen-preedit");
    this.statusEl = $(".zen-status");
    this.barEl = $(".zen-bar");
    this.helpEl = $(".zen-help");
    this.emptyEl = $(".zen-empty");

    this.input = new InputSink({
      context: () => this.inputContext(),
      apply: (e) => this.onInput(e),
      key: (k) => this.onKey(k),
      preedit: (t) => {
        this.preedit = t;
        this.schedule();
      },
    });
    this.input.el.classList.add("zen-input");
    this.view.appendChild(this.input.el);
    this.input.el.addEventListener("copy", (e) => this.onCopyEvent(e, false));
    this.input.el.addEventListener("cut", (e) => this.onCopyEvent(e, true));
    this.input.el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) this.onPaste(text);
    });
    this.input.el.addEventListener("focus", () => this.root.classList.add("focused"));
    this.input.el.addEventListener("blur", () => this.root.classList.remove("focused"));

    this.buildBar();
    this.helpEl.innerHTML = `<div class="zen-help-box"><div class="zen-help-brand">zencode  젠코드  ゼンコード</div>${HELP_LINES.map(
      (l) => `<div>${esc(l) || "&nbsp;"}</div>`,
    ).join("")}<div class="zen-help-dismiss">Press any key or tap to close</div></div>`;
    this.helpEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.showHelp = false;
      this.schedule();
    });

    this.bindPointer();
    contextMenu(this.view, () => this.menu());
    new ResizeObserver(() => this.measure()).observe(this.view);
    document.fonts?.ready.then(() => this.measure());
  }

  // ----- public ------------------------------------------------------------

  setDoc(doc: Doc | null): void {
    this.input.commit();
    this.closePrompt();
    this.search = null;
    this.doc = doc;
    this.followCursor = true;
    this.input.sync();
    this.schedule();
  }

  focus(): void {
    if (this.prompt?.input) this.prompt.input.focus();
    else this.input.focus();
  }

  /** Re-render, e.g. after the doc's highlighter changed. */
  refresh(): void {
    this.schedule();
  }

  setStatus(text: string, error = false): void {
    this.status = { text, error, until: performance.now() + STATUS_TTL };
    clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => this.schedule(), STATUS_TTL + 50);
    this.schedule();
  }

  /** Run a shortcut-bar action, for buttons elsewhere in the app. */
  perform(action: Action): void {
    if (!this.doc) return;
    this.followCursor = true;
    switch (action) {
      case "close":
        return this.tryClose();
      case "save":
        return void this.save();
      case "export":
        return this.openPrompt({ t: "export" });
      case "find":
        return this.openSearch(false);
      case "findExact":
        return this.openSearch(true);
      case "help":
        this.showHelp = true;
        return this.schedule();
      case "copy":
        return this.copy();
      case "extract":
        return this.edit(EditKind.Other, () => this.extractInner());
      case "paste":
        return this.edit(EditKind.Other, () => this.pasteInner());
      case "selectAll":
        return this.selectAll();
      case "undo":
        return this.undo();
      case "redo":
        return this.redo();
    }
  }

  // ----- input ---------------------------------------------------------------

  private inputContext(): { before: string; after: string } {
    const d = this.doc;
    if (!d || this.prompt) return { before: "", after: "" };
    const line = d.buf.lines[d.cy];
    const at = codeIndex(line, d.cx);
    return { before: line.slice(0, at), after: line.slice(at) };
  }

  /** Text typed through the keyboard or an IME. */
  private onInput(e: Edit): void {
    const d = this.doc;
    if (!d) return;
    if (this.showHelp) {
      this.showHelp = false;
      return this.schedule();
    }
    if (this.prompt) return;
    this.followCursor = true;
    // Mobile keyboards send Enter as a newline in the text.
    if (e.insert === "\n" && !e.deleteBefore && !e.deleteAfter) {
      this.edit(EditKind.Other, () => this.insert("\n"));
      return this.schedule();
    }
    if (!e.insert && e.deleteBefore === 1 && !e.deleteAfter) {
      this.backspace();
      return this.schedule();
    }
    if (!e.insert && e.deleteAfter === 1 && !e.deleteBefore) {
      this.deleteForward();
      return this.schedule();
    }
    const kind = e.insert.includes("\n") || e.deleteBefore || e.deleteAfter ? EditKind.Other : EditKind.Type;
    this.edit(kind, () => {
      if (!this.deleteSelection()) {
        const start: Pos = [d.cy, Math.max(0, d.cx - e.deleteBefore)];
        const end: Pos = [d.cy, Math.min(d.buf.lineLen(d.cy), d.cx + e.deleteAfter)];
        d.buf.deleteRange(start, end);
        this.moveTo(start);
      }
      if (e.insert) this.insert(e.insert);
    });
    this.schedule();
  }

  private onPaste(text: string): void {
    if (!this.doc || this.prompt) return;
    this.followCursor = true;
    this.edit(EditKind.Other, () => this.insert(text));
    this.schedule();
  }

  private onCopyEvent(e: ClipboardEvent, cut: boolean): void {
    const d = this.doc;
    const sel = this.selection();
    if (!d || !sel) return;
    e.preventDefault();
    const text = d.buf.textRange(sel[0], sel[1]);
    e.clipboardData?.setData("text/plain", text);
    this.clip = { text, linewise: false };
    if (cut) {
      this.edit(EditKind.Other, () => this.deleteSelection());
      this.setStatus(`Extracted ${describe(text)}`);
    } else {
      this.setStatus(`Copied ${describe(text)}`);
    }
    this.schedule();
  }

  private onKey(k: Key): boolean {
    this.followCursor = true;
    if (this.showHelp) {
      this.showHelp = false;
      this.schedule();
      return true;
    }
    const d = this.doc;
    if (!d) return false;
    if (this.prompt) return this.onPromptKey(k);
    const { ctrl, alt, shift, meta } = k;
    const c = k.key;
    const handled = (() => {
      if (ctrl && c === "x" && shift) {
        this.host.close(d);
        return true;
      }
      if (meta && !ctrl && !alt) {
        // macOS: ⌘S saves; ⌘ arrows move to line / file edges like native fields.
        if (c === "s") return this.perform("save"), true;
        if (c === "ArrowLeft") return this.motion("home", shift), true;
        if (c === "ArrowRight") return this.motion("end", shift), true;
        if (c === "ArrowUp") return this.motion("top", shift), true;
        if (c === "ArrowDown") return this.motion("bottom", shift), true;
        return false;
      }
      if (ctrl && !alt) {
        switch (c) {
          case "x":
            return this.perform("close"), true;
          case "s":
            return this.perform("save"), true;
          case "o":
            return this.perform("export"), true;
          case "f":
            return this.perform("find"), true;
          case "g":
            return this.perform("findExact"), true;
          case "/":
          case "7":
          case "_":
            return this.perform("help"), true;
          case "c":
            return this.perform("copy"), true;
          case "b":
            return this.perform("extract"), true;
          case "v":
            return this.perform("paste"), true;
          case "a":
            return this.perform("selectAll"), true;
          case "h":
          case "w":
            return this.deleteBlock(true), true;
          case "d":
            return this.deleteForward(), true;
        }
      }
      if ((ctrl || alt) && c === "e") return this.perform("undo"), true;
      if ((ctrl || alt) && c === "r") return this.perform("redo"), true;
      if (alt && !ctrl && c === "d") return this.deleteBlock(false), true;
      if (alt && !ctrl && (c === "b" || c === "f")) return this.motion(c === "b" ? "wordLeft" : "wordRight", shift), true;
      if (c === "F1") return this.perform("help"), true;
      if ((ctrl || alt) && c === "Backspace") return this.deleteBlock(true), true;
      if ((ctrl || alt) && c === "Delete") return this.deleteBlock(false), true;
      // With ⇧ held the user is adjusting a selection, so ⇧⌃↑↓ falls through to ⇧↑↓.
      if ((ctrl || alt) && !shift && c === "ArrowUp") return this.moveLines(true), true;
      if ((ctrl || alt) && !shift && c === "ArrowDown") return this.moveLines(false), true;
      if ((ctrl || alt) && c === "ArrowLeft") return this.motion("wordLeft", shift), true;
      if ((ctrl || alt) && c === "ArrowRight") return this.motion("wordRight", shift), true;
      if (ctrl && c === "Home") return this.motion("top", shift), true;
      if (ctrl && c === "End") return this.motion("bottom", shift), true;
      if (ctrl || alt) return false;
      switch (c) {
        case "ArrowLeft":
          return this.motion("left", shift), true;
        case "ArrowRight":
          return this.motion("right", shift), true;
        case "ArrowUp":
          return this.motion("up", shift), true;
        case "ArrowDown":
          return this.motion("down", shift), true;
        case "Home":
          return this.motion("home", shift), true;
        case "End":
          return this.motion("end", shift), true;
        case "PageUp":
          return this.motion("pageUp", shift), true;
        case "PageDown":
          return this.motion("pageDown", shift), true;
        case "Escape":
          d.anchor = null;
          d.history.breakStep();
          return true;
        case "Backspace":
          return this.backspace(), true;
        case "Delete":
          return this.deleteForward(), true;
        case "Enter":
          return this.edit(EditKind.Other, () => this.insert("\n")), true;
        case "Tab":
          return this.edit(EditKind.Type, () => this.insert("\t")), true;
      }
      // A character with sticky ⇧ from the key bar.
      if ([...c].length === 1) return this.edit(EditKind.Type, () => this.insert(c)), true;
      return false;
    })();
    if (handled) this.schedule();
    return handled;
  }

  // ----- prompts -------------------------------------------------------------

  private openPrompt(kind: PromptKind): void {
    this.input.commit();
    this.status = null;
    const yesNo = kind.t === "overwrite" || kind.t === "confirmClose";
    let input: HTMLInputElement | null = null;
    if (!yesNo) {
      input = document.createElement("input");
      input.className = "zen-prompt-input";
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocorrect", "off");
      input.spellcheck = false;
      input.enterKeyHint = kind.t === "search" ? "search" : "done";
      input.value = kind.t === "search" ? this.lastSearch : "";
      input.addEventListener("input", () => this.refreshSearch());
      input.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        const cancel = e.key === "Escape" || (e.ctrlKey && e.code === "KeyC");
        if (cancel) {
          e.preventDefault();
          this.cancelPrompt();
        } else if (e.key === "Enter") {
          e.preventDefault();
          this.submitPrompt();
        } else if (e.key === "Tab") {
          e.preventDefault();
          this.stepSearch(!e.shiftKey);
        }
      });
    }
    this.prompt = { kind, input };
    this.renderStatus();
    if (input) {
      input.focus();
      input.select();
    } else {
      this.input.focus();
    }
  }

  private closePrompt(): void {
    if (!this.prompt) return;
    this.prompt = null;
    this.renderStatus();
    this.input.focus();
  }

  private cancelPrompt(): void {
    if (this.search) {
      this.restoreOrigin();
      this.search = null;
    }
    this.closePrompt();
    this.setStatus("Cancelled");
  }

  private onPromptKey(k: Key): boolean {
    const p = this.prompt!;
    if (k.key === "Escape" || (k.ctrl && k.key === "c")) {
      this.cancelPrompt();
      return true;
    }
    if (p.input) {
      // Key bar keys while the prompt's own field has focus.
      if (k.key === "Enter") this.submitPrompt();
      else if (k.key === "Tab") this.stepSearch(!k.shift);
      else return false;
      return true;
    }
    const yes = k.key === "y" || k.key === "Y";
    const no = k.key === "n" || k.key === "N";
    if (!yes && !no) return true;
    const kind = p.kind;
    this.closePrompt();
    if (kind.t === "confirmClose") {
      if (yes) void this.save(true);
      else this.host.close(this.doc!);
    } else if (kind.t === "overwrite") {
      if (yes) void this.exportTo(kind.path);
      else this.setStatus("Cancelled");
    }
    return true;
  }

  private async submitPrompt(): Promise<void> {
    const p = this.prompt;
    if (!p?.input) return;
    const value = p.input.value;
    const d = this.doc!;
    if (p.kind.t === "export") {
      this.closePrompt();
      if (!value) return this.setStatus("Cancelled");
      const path = this.host.resolve(d, value);
      if (await this.host.exists(path)) this.openPrompt({ t: "overwrite", path });
      else await this.exportTo(path);
    } else if (p.kind.t === "search") {
      const s = this.search;
      this.search = null;
      this.closePrompt();
      if (!value) return this.setStatus("Cancelled");
      // The current match stays selected.
      if (s?.current != null) this.setStatus(`Match ${s.current + 1} of ${s.matches.length}`);
      else this.setStatus(`"${value}" not found`);
      this.lastSearch = value;
    }
  }

  // ----- commands ------------------------------------------------------------

  private tryClose(): void {
    if (this.doc!.dirty) this.openPrompt({ t: "confirmClose" });
    else this.host.close(this.doc!);
  }

  private async save(thenClose = false): Promise<void> {
    const d = this.doc!;
    try {
      await this.host.save(d);
      d.savedState = d.state;
      d.history.breakStep();
      const n = d.buf.lines.length;
      this.setStatus(`Wrote ${n} line${plural(n)}`);
      this.host.changed(d);
      if (thenClose) this.host.close(d);
    } catch (e) {
      this.setStatus(`Error writing: ${(e as Error).message}`, true);
    }
  }

  private async exportTo(path: string): Promise<void> {
    const d = this.doc!;
    try {
      await this.host.write(path, d.buf.serialize());
      const n = d.buf.lines.length;
      this.setStatus(`Exported ${n} line${plural(n)} to ${path}`);
    } catch (e) {
      this.setStatus(`Error writing: ${(e as Error).message}`, true);
    }
  }

  private insert(s: string): void {
    const d = this.doc!;
    this.deleteSelection();
    [d.cy, d.cx] = d.buf.insertStr(d.cy, d.cx, s);
    this.syncWantCol();
  }

  private backspace(): void {
    this.edit(EditKind.Backspace, () => {
      const d = this.doc!;
      if (!this.deleteSelection()) {
        [d.cy, d.cx] = d.buf.backspace(d.cy, d.cx);
        this.syncWantCol();
      }
    });
  }

  private deleteForward(): void {
    this.edit(EditKind.Delete, () => {
      const d = this.doc!;
      if (!this.deleteSelection()) d.buf.delete(d.cy, d.cx);
    });
  }

  /** Delete to the edge of the letterblock on one side of the cursor. At a line edge this joins lines, like ⌫ / ⌦. */
  private deleteBlock(left: boolean): void {
    this.edit(left ? EditKind.Backspace : EditKind.Delete, () => {
      const d = this.doc!;
      if (this.deleteSelection()) return;
      const { cy, cx } = d;
      const line = d.buf.lines[cy];
      if (left && cx === 0) {
        [d.cy, d.cx] = d.buf.backspace(cy, cx);
        this.syncWantCol();
      } else if (left) {
        const to = letterblock.left(line, cx);
        d.buf.deleteRange([cy, to], [cy, cx]);
        this.moveTo([cy, to]);
      } else if (cx === d.buf.lineLen(cy)) {
        d.buf.delete(cy, cx);
      } else {
        d.buf.deleteRange([cy, cx], [cy, letterblock.right(line, cx)]);
      }
    });
  }

  // ----- undo & redo -----------------------------------------------------------

  private snapshot(): Snapshot {
    const d = this.doc!;
    return { lines: [...d.buf.lines], cursor: [d.cy, d.cx], anchor: d.anchor, state: d.state };
  }

  private restore(s: Snapshot): void {
    const d = this.doc!;
    d.buf.lines = s.lines;
    d.buf.revision++;
    d.state = s.state;
    d.anchor = s.anchor;
    this.moveTo(s.cursor);
    this.host.changed(d);
  }

  /** Run a buffer edit and record it for undo; the snapshot is only kept if something changed. */
  private edit(kind: EditKind, f: () => void): void {
    const d = this.doc!;
    // Typing over a selection replaces it, which is its own step. Moving a
    // selected block of lines repeatedly is still one step.
    const selectionOk = kind === EditKind.MoveLines || this.selection() === null;
    const joins = selectionOk && d.history.continues(kind, [d.cy, d.cx]);
    const before = joins ? null : this.snapshot();
    const revision = d.buf.revision;
    const wasDirty = d.dirty;
    f();
    if (d.buf.revision === revision) return;
    d.state = d.buf.revision;
    d.history.record(before, kind, [d.cy, d.cx]);
    if (wasDirty !== d.dirty) this.host.changed(d);
  }

  private undo(): void {
    const prev = this.doc!.history.undo(this.snapshot());
    if (prev) this.restore(prev);
    else this.setStatus("Nothing to undo");
  }

  private redo(): void {
    const next = this.doc!.history.redo(this.snapshot());
    if (next) this.restore(next);
    else this.setStatus("Nothing to redo");
  }

  // ----- selection & clipboard ---------------------------------------------------

  /** The selected range, ordered, or null if nothing is selected. */
  private selection(): [Pos, Pos] | null {
    const d = this.doc;
    if (!d?.anchor) return null;
    const c: Pos = [d.cy, d.cx];
    const cmp = posCmp(d.anchor, c);
    if (cmp === 0) return null;
    return cmp < 0 ? [d.anchor, c] : [c, d.anchor];
  }

  private deleteSelection(): boolean {
    const d = this.doc!;
    const sel = this.selection();
    d.anchor = null;
    if (!sel) return false;
    d.buf.deleteRange(sel[0], sel[1]);
    this.moveTo(sel[0]);
    return true;
  }

  private selectAll(): void {
    const d = this.doc!;
    d.history.breakStep();
    d.anchor = [0, 0];
    this.moveTo(d.buf.end());
    this.schedule();
  }

  private setClip(text: string, linewise: boolean): void {
    this.clip = { text, linewise };
    navigator.clipboard?.writeText(linewise ? text + "\n" : text).catch(() => {});
  }

  private copy(): void {
    const d = this.doc!;
    const sel = this.selection();
    if (sel) {
      const text = d.buf.textRange(sel[0], sel[1]);
      this.setClip(text, false);
      this.setStatus(`Copied ${describe(text)}`);
    } else {
      this.setClip(d.buf.lines[d.cy], true);
      this.setStatus("Copied line");
    }
  }

  private extractInner(): void {
    const d = this.doc!;
    const sel = this.selection();
    if (sel) {
      const text = d.buf.textRange(sel[0], sel[1]);
      this.setClip(text, false);
      this.deleteSelection();
      this.setStatus(`Extracted ${describe(text)}`);
    } else {
      this.setClip(d.buf.cutLine(d.cy), true);
      this.moveTo([Math.min(d.cy, d.buf.lines.length - 1), 0]);
      this.setStatus("Extracted line");
    }
  }

  private pasteInner(): void {
    const d = this.doc!;
    const clip = this.clip;
    if (!clip) {
      this.setStatus("Clipboard is empty. ⌘V / ⌃⇧V pastes from other apps");
      return;
    }
    if (clip.linewise && !this.selection()) {
      // Whole lines go in above the cursor line, like they came out.
      d.anchor = null;
      d.buf.pasteLines(d.cy, [clip.text]);
      d.cy++;
      d.cx = gidxForCol(d.buf.lines[d.cy], d.wantCol);
    } else {
      this.insert(clip.text);
    }
  }

  private async pasteSystem(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.onPaste(text);
      else this.setStatus("System clipboard is empty");
    } catch {
      this.setStatus("The browser didn't allow reading the clipboard", true);
    }
  }

  // ----- search ------------------------------------------------------------------

  private openSearch(exact: boolean): void {
    const d = this.doc!;
    d.history.breakStep();
    this.search = { exact, origin: [[d.cy, d.cx], d.anchor], matches: [], byRow: new Map(), current: null };
    this.openPrompt({ t: "search", exact });
    this.refreshSearch();
  }

  /** Re-run the search and select the first match at or after where it began. */
  private refreshSearch(): void {
    const s = this.search;
    const q = this.prompt?.input?.value ?? "";
    if (!s) return;
    if (!q) {
      s.matches = [];
      s.current = null;
    } else {
      s.matches = new Matcher(q, s.exact).findAll(this.doc!.buf.lines);
      const origin = s.origin[0];
      const i = s.matches.findIndex((m) => posCmp([m.row, m.start], origin) >= 0);
      s.current = s.matches.length ? Math.max(0, i) : null;
    }
    s.byRow = new Map();
    for (const m of s.matches) {
      const list = s.byRow.get(m.row);
      if (list) list.push(m);
      else s.byRow.set(m.row, [m]);
    }
    this.showCurrentMatch();
  }

  /** Tab / ⇧Tab: the next or previous match, wrapping around. */
  private stepSearch(forward: boolean): void {
    const s = this.search;
    if (!s || s.current === null) return;
    const n = s.matches.length;
    s.current = forward ? (s.current + 1) % n : (s.current + n - 1) % n;
    this.showCurrentMatch();
  }

  private showCurrentMatch(): void {
    const s = this.search;
    if (!s) return;
    const m = s.current === null ? null : s.matches[s.current];
    if (m) {
      this.doc!.anchor = [m.row, m.start];
      this.moveTo([m.row, m.end]);
    } else {
      this.restoreOrigin();
    }
    this.followCursor = true;
    this.renderStatus();
    this.schedule();
  }

  private restoreOrigin(): void {
    const s = this.search;
    if (!s) return;
    this.doc!.anchor = s.origin[1];
    this.moveTo(s.origin[0]);
  }

  /** Swap the cursor line (or every line the selection touches) with its neighbor. */
  private moveLines(up: boolean): void {
    this.edit(EditKind.MoveLines, () => {
      const d = this.doc!;
      const sel = this.selection();
      let r0 = d.cy;
      let r1 = d.cy;
      if (sel) {
        // A selection ending at column 0 doesn't include that line.
        [r0, r1] = sel[1][1] === 0 && sel[1][0] > sel[0][0] ? [sel[0][0], sel[1][0] - 1] : [sel[0][0], sel[1][0]];
      }
      if (!d.buf.moveLines(r0, r1, up)) return;
      const end = d.buf.end();
      const shift = ([row, col]: Pos): Pos => {
        const r = up ? row - 1 : row + 1;
        return r > end[0] ? end : [r, col];
      };
      [d.cy, d.cx] = shift([d.cy, d.cx]);
      if (d.anchor) d.anchor = shift(d.anchor);
    });
  }

  // ----- movement --------------------------------------------------------------

  private syncWantCol(): void {
    const d = this.doc!;
    d.wantCol = displayCol(d.buf.lines[d.cy], d.cx);
  }

  private moveTo([row, gidx]: Pos): void {
    const d = this.doc!;
    d.cy = row;
    d.cx = Math.min(gidx, d.buf.lineLen(row));
    this.syncWantCol();
  }

  /** Move the cursor. With `extend` the selection grows; without it, any selection is dropped (←/→ collapse it). */
  private motion(m: string, extend: boolean): void {
    const d = this.doc!;
    d.history.breakStep();
    if (extend) {
      d.anchor ??= [d.cy, d.cx];
    } else {
      const sel = this.selection();
      d.anchor = null;
      if (sel && m === "left") return this.moveTo(sel[0]);
      if (sel && m === "right") return this.moveTo(sel[1]);
    }
    const { cy, cx } = d;
    const len = d.buf.lineLen(cy);
    const last = d.buf.lines.length - 1;
    switch (m) {
      case "left":
        if (cx > 0) this.moveTo([cy, cx - 1]);
        else if (cy > 0) this.moveTo([cy - 1, d.buf.lineLen(cy - 1)]);
        break;
      case "right":
        if (cx < len) this.moveTo([cy, cx + 1]);
        else if (cy < last) this.moveTo([cy + 1, 0]);
        break;
      case "wordLeft":
        if (cx > 0) this.moveTo([cy, letterblock.left(d.buf.lines[cy], cx)]);
        else if (cy > 0) this.moveTo([cy - 1, d.buf.lineLen(cy - 1)]);
        break;
      case "wordRight":
        if (cx < len) this.moveTo([cy, letterblock.right(d.buf.lines[cy], cx)]);
        else if (cy < last) this.moveTo([cy + 1, 0]);
        break;
      case "up":
        return this.moveVert(-1);
      case "down":
        return this.moveVert(1);
      case "pageUp":
        return this.moveVert(-Math.max(1, this.rows));
      case "pageDown":
        return this.moveVert(Math.max(1, this.rows));
      case "home":
        return this.moveTo([cy, 0]);
      case "end":
        return this.moveTo([cy, len]);
      case "top":
        return this.moveTo([0, 0]);
      case "bottom":
        return this.moveTo(d.buf.end());
    }
  }

  private moveVert(delta: number): void {
    const d = this.doc!;
    const row = Math.max(0, Math.min(d.buf.lines.length - 1, d.cy + delta));
    d.cy = row;
    d.cx = gidxForCol(d.buf.lines[row], d.wantCol);
  }

  // ----- pointer: mouse, touch and pen --------------------------------------------

  /** Screen point to [row, display column], clamped to the buffer. */
  private pointToText(x: number, y: number): [number, number] {
    const d = this.doc!;
    const r = this.view.getBoundingClientRect();
    const screenRow = Math.floor((y - r.top) / this.lh);
    const row = Math.max(0, Math.min(d.buf.lines.length - 1, d.rowOff + screenRow));
    return [row, Math.max(0, Math.floor((x - r.left) / this.cw) - this.gutter + d.colOff)];
  }

  private inGutter(x: number): boolean {
    return x - this.view.getBoundingClientRect().left < this.gutter * this.cw;
  }

  /** A click or tap: place the cursor, ⇧ extends; double selects a letterblock, triple the line. */
  private click(x: number, y: number, extend: boolean): void {
    const d = this.doc!;
    const [row, col] = this.pointToText(x, y);
    const now = performance.now();
    const last = this.lastClick;
    const count = last && last.row === row && Math.abs(last.col - col) <= 1 && now - last.at < MULTI_CLICK ? (last.count % 3) + 1 : 1;
    this.followCursor = true;
    d.history.breakStep();
    const line = d.buf.lines[row];
    const origin: Pos = [row, nearestBoundary(line, col)];
    if (count === 1 && extend) {
      d.anchor ??= [d.cy, d.cx];
      this.moveTo(origin);
    } else if (count === 1) {
      d.anchor = null;
      this.moveTo(origin);
    } else if (count === 2) {
      const b = letterblock.blockAt(line, gidxForCol(line, col));
      d.anchor = [row, b.start];
      this.moveTo([row, b.end]);
    } else {
      d.anchor = [row, 0];
      this.moveTo([row, d.buf.lineLen(row)]);
    }
    this.lastClick = { at: now, row, col, count, origin };
    this.schedule();
  }

  /** Extend the selection to a point, as a drag does. */
  private dragTo(x: number, y: number): void {
    const d = this.doc!;
    const [row, col] = this.pointToText(x, y);
    d.anchor ??= this.lastClick?.origin ?? [d.cy, d.cx];
    this.followCursor = true;
    this.moveTo([row, nearestBoundary(d.buf.lines[row], col)]);
    if (posEq(d.anchor, [d.cy, d.cx])) d.anchor = null;
    this.schedule();
  }

  private scrollBy(rows: number, cols: number): void {
    const d = this.doc;
    if (!d) return;
    d.rowOff = Math.max(0, Math.min(d.buf.lines.length - 1, d.rowOff + rows));
    d.colOff = Math.max(0, d.colOff + cols);
    this.followCursor = false;
    this.schedule();
  }

  private bindPointer(): void {
    const v = this.view;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "none" | "mouse" | "touch-pending" | "touch-drag" | "scroll" = "none";
    let start = { x: 0, y: 0 };
    let scrollAcc = { x: 0, y: 0 };
    let last = { x: 0, y: 0 };

    const mid = () => {
      let x = 0;
      let y = 0;
      for (const p of pointers.values()) {
        x += p.x;
        y += p.y;
      }
      return { x: x / pointers.size, y: y / pointers.size };
    };

    v.addEventListener("pointerdown", (e) => {
      if (!this.doc || e.button > 0) return;
      if ((e.target as HTMLElement).closest(".zen-empty")) return;
      e.preventDefault();
      this.input.commit();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(v, e.pointerId);
      if (e.pointerType === "mouse") {
        mode = "mouse";
        this.click(e.clientX, e.clientY, e.shiftKey);
        this.focus();
        return;
      }
      if (pointers.size >= 2 || this.inGutter(e.clientX)) {
        mode = "scroll";
        last = mid();
        scrollAcc = { x: 0, y: 0 };
        return;
      }
      mode = "touch-pending";
      start = { x: e.clientX, y: e.clientY };
    });

    v.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "mouse" && e.buttons & 1) {
        this.dragTo(e.clientX, e.clientY);
      } else if (mode === "touch-pending" && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) {
        // One-finger drag is ⇧+drag: the selection grows from the cursor.
        mode = "touch-drag";
        this.doc!.history.breakStep();
        this.doc!.anchor ??= [this.doc!.cy, this.doc!.cx];
        this.lastClick = null;
        this.dragTo(e.clientX, e.clientY);
      } else if (mode === "touch-drag") {
        this.dragTo(e.clientX, e.clientY);
      } else if (mode === "scroll") {
        const m = mid();
        scrollAcc.y += last.y - m.y;
        scrollAcc.x += last.x - m.x;
        last = m;
        const rows = Math.trunc(scrollAcc.y / this.lh);
        const cols = Math.trunc(scrollAcc.x / this.cw);
        if (rows || cols) {
          scrollAcc.y -= rows * this.lh;
          scrollAcc.x -= cols * this.cw;
          this.scrollBy(rows, cols);
        }
      }
    });

    const end = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (mode === "touch-pending" && e.type === "pointerup") {
        this.click(start.x, start.y, false);
        this.focus();
      }
      if (pointers.size === 0) mode = "none";
      else if (mode !== "scroll") mode = "none";
    };
    v.addEventListener("pointerup", end);
    v.addEventListener("pointercancel", end);
    // The long press opened the menu; whatever the finger was doing is over.
    v.addEventListener("longpress", () => {
      pointers.clear();
      mode = "none";
    });
    v.addEventListener(
      "wheel",
      (e) => {
        if (!this.doc) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? this.rows : 1 / this.lh;
        const dy = e.deltaY * unit;
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * (e.deltaMode ? 1 : 1 / this.cw);
        scrollAcc.y += e.shiftKey ? 0 : dy;
        scrollAcc.x += dx;
        const rows = Math.trunc(scrollAcc.y);
        const cols = Math.trunc(scrollAcc.x);
        if (rows || cols) {
          scrollAcc.y -= rows;
          scrollAcc.x -= cols;
          this.scrollBy(rows, cols);
        }
      },
      { passive: false },
    );
  }

  private menu(): MenuItem[] | null {
    if (!this.doc) return null;
    const sel = this.selection() !== null;
    const run = (a: Action) => () => {
      this.perform(a);
      this.focus();
    };
    return [
      { label: "Undo", hint: "⌃E", action: run("undo") },
      { label: "Redo", hint: "⌃R", action: run("redo") },
      "separator",
      { label: sel ? "Copy" : "Copy Line", hint: "⌃C", action: run("copy") },
      { label: sel ? "Extract" : "Extract Line", hint: "⌃B", action: run("extract") },
      { label: "Paste", hint: "⌃V", action: run("paste"), disabled: !this.clip },
      { label: "Paste from System", hint: "⌘V", action: () => void this.pasteSystem() },
      { label: "Select All", hint: "⌃A", action: run("selectAll") },
      "separator",
      { label: "Find", hint: "⌃F", action: run("find") },
      { label: "Find Exact", hint: "⌃G", action: run("findExact") },
      "separator",
      { label: "Save", hint: "⌃S", action: run("save") },
      { label: "Export…", hint: "⌃O", action: run("export") },
      { label: "Close", hint: "⌃X", action: run("close") },
    ];
  }

  // ----- rendering -----------------------------------------------------------------

  private buildBar(): void {
    this.barEl.innerHTML = "";
    for (const [keys, label, action] of SHORTCUTS) {
      const el = document.createElement(action ? "button" : "span");
      el.className = "zen-short";
      el.innerHTML = `<kbd></kbd><span></span>`;
      el.firstElementChild!.textContent = keys;
      el.lastElementChild!.textContent = label;
      if (action) {
        (el as HTMLButtonElement).type = "button";
        // Keep focus (and the soft keyboard) in the editor.
        el.addEventListener("pointerdown", (e) => e.preventDefault());
        el.addEventListener("click", () => {
          this.perform(action);
          this.focus();
        });
      } else {
        el.classList.add("hint");
      }
      this.barEl.appendChild(el);
    }
  }

  private measure(): void {
    const probe = this.root.querySelector(".zen-probe") as HTMLElement;
    const w = probe.getBoundingClientRect().width / 10;
    if (w > 0) this.cw = w;
    const lh = parseFloat(getComputedStyle(this.view).lineHeight);
    if (lh > 0) this.lh = lh;
    this.root.style.setProperty("--cw", `${this.cw}px`);
    this.root.style.setProperty("--lh", `${this.lh}px`);
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private scrollToCursor(): void {
    const d = this.doc!;
    if (d.cy < d.rowOff) d.rowOff = d.cy;
    if (d.cy >= d.rowOff + this.rows) d.rowOff = d.cy - this.rows + 1;
    const line = d.buf.lines[d.cy];
    const col = displayCol(line, d.cx);
    const w = widthAt(line, d.cx);
    if (col < d.colOff) d.colOff = col;
    if (col + w > d.colOff + this.cols) d.colOff = col + w - this.cols;
  }

  private render(): void {
    const d = this.doc;
    this.helpEl.hidden = !this.showHelp;
    this.emptyEl.hidden = !!d;
    this.root.classList.toggle("empty", !d);
    if (!d) {
      this.rowsEl.innerHTML = "";
      this.cursorEl.hidden = true;
      this.preeditEl.hidden = true;
      this.renderStatus();
      return;
    }
    const lines = d.buf.lines;
    this.gutter = String(lines.length).length + 2;
    const vw = this.view.clientWidth;
    const vh = this.view.clientHeight;
    this.rows = Math.max(1, Math.floor(vh / this.lh));
    this.cols = Math.max(1, Math.floor(vw / this.cw) - this.gutter);
    if (this.followCursor) this.scrollToCursor();

    const last = Math.min(lines.length - 1, d.rowOff + this.rows);
    const tokens = d.tokens(last);
    const sel = this.selection();
    const html: string[] = [];
    for (let row = d.rowOff; row <= last; row++) {
      const cur = row === d.cy ? " cur" : "";
      const n = String(row + 1).padStart(this.gutter - 1, " ");
      html.push(`<div class="zr${cur}"><span class="ln">${n} </span>${this.renderLine(row, tokens[row] ?? [], sel)}</div>`);
    }
    this.rowsEl.innerHTML = html.join("");

    // Cursor, preedit and the hidden textarea sit at the caret, so the IME
    // candidate window opens next to it.
    const line = lines[d.cy];
    const screenRow = d.cy - d.rowOff;
    const x = (this.gutter + displayCol(line, d.cx) - d.colOff) * this.cw;
    const y = screenRow * this.lh;
    const visible = screenRow >= 0 && screenRow < this.rows + 1 && x >= this.gutter * this.cw;
    this.cursorEl.hidden = !visible;
    this.cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    this.cursorEl.style.width = `${widthAt(line, d.cx) * this.cw}px`;
    this.cursorEl.classList.remove("blink");
    void this.cursorEl.offsetWidth;
    this.cursorEl.classList.add("blink");
    this.preeditEl.hidden = !this.preedit;
    this.preeditEl.textContent = this.preedit;
    this.preeditEl.style.transform = `translate(${x}px, ${y}px)`;
    this.input.el.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
    this.renderStatus();
  }

  /** One line as HTML: the visible columns only, every grapheme on the grid. */
  private renderLine(row: number, tokens: Token[], sel: [Pos, Pos] | null): string {
    const d = this.doc!;
    const line = d.buf.lines[row];
    const gs = graphemes(line);
    const matches = this.search?.byRow.get(row) ?? [];
    const current = this.search?.current != null ? this.search.matches[this.search.current] : null;
    let selStart = -1;
    let selEnd = -1;
    let selEol = false;
    if (sel) {
      const [[r0, c0], [r1, c1]] = sel;
      if (row >= r0 && row <= r1) {
        selStart = row === r0 ? c0 : 0;
        selEnd = row === r1 ? c1 : gs.length;
        selEol = row < r1;
      }
    }
    const left = d.colOff;
    const right = d.colOff + this.cols;
    let col = 0;
    let off = 0;
    let ti = 0;
    let mi = 0;
    let run = "";
    let runCls = "";
    const out: string[] = [];
    const flush = () => {
      if (run) out.push(runCls ? `<span class="${runCls}">${esc(run)}</span>` : esc(run));
      run = "";
    };
    for (let i = 0; i < gs.length && col < right; i++) {
      const g = gs[i];
      const w = graphemeWidth(g, col);
      const start = col;
      col += w;
      const gOff = off;
      off += g.length;
      if (col <= left) continue;
      while (ti < tokens.length && tokens[ti].end <= gOff) ti++;
      while (mi < matches.length && matches[mi].end <= i) mi++;
      const cls: string[] = [];
      const t = tokens[ti];
      if (t && t.start <= gOff) cls.push(`t-${t.scope.split(".")[0]}`);
      const m = matches[mi];
      if (m && m.start <= i) cls.push(current && current.row === row && current.start === m.start ? "mcur" : "m");
      if (i >= selStart && i < selEnd) cls.push("sel");
      let text = g;
      let cellW = w;
      if (g === "\t") {
        cls.push("tabch");
        text = "→" + " ".repeat(Math.max(0, w - 1));
      } else if (isControl(g)) {
        cls.push("ctl");
        text = "�";
      } else if (g === "　") {
        cls.push("zs");
      }
      if (start < left) {
        // A wide character cut by the left edge: show its visible half as blank.
        text = " ".repeat(col - left);
        cellW = col - left;
      }
      const c = cls.join(" ");
      const ascii = text.length === cellW && /^[\x20-\x7e]+$/.test(text);
      if (ascii) {
        if (c !== runCls) flush();
        runCls = c;
        run += text;
      } else {
        flush();
        runCls = "";
        // Tabs can span up to TAB_WIDTH cells; .g and .g.w only size one or two.
        const wide = cellW > 2 ? ` style="width: calc(var(--cw) * ${cellW})"` : "";
        out.push(`<span class="g${cellW === 2 ? " w" : cellW === 0 ? " z" : ""}${c ? " " + c : ""}"${wide}>${esc(text)}</span>`);
      }
    }
    flush();
    if (selEol && col < right) out.push(`<span class="sel"> </span>`);
    return out.join("");
  }

  private renderStatus(): void {
    const el = this.statusEl;
    const d = this.doc;
    const p = this.prompt;
    if (p) {
      el.className = "zen-status prompt";
      const label = {
        export: "Export to:",
        overwrite: `File exists, overwrite ${p.kind.t === "overwrite" ? p.kind.path : ""}? (y/n)`,
        search: p.kind.t === "search" && p.kind.exact ? "Find exactly:" : "Find:",
        confirmClose: "Save modified buffer? (y/n, Esc cancels)",
      }[p.kind.t];
      let badge = "";
      const s = this.search;
      if (s && p.input?.value) {
        badge = s.current === null ? "No matches" : `${s.current + 1} / ${s.matches.length}`;
      }
      if (!el.querySelector(".zen-prompt-label") || el.dataset.kind !== p.kind.t) {
        el.dataset.kind = p.kind.t;
        el.innerHTML = `<span class="zen-prompt-label"></span><span class="zen-prompt-field"></span><span class="zen-badge"></span>`;
        if (p.input) el.querySelector(".zen-prompt-field")!.appendChild(p.input);
        if (!p.input) {
          const yes = document.createElement("button");
          const no = document.createElement("button");
          yes.textContent = "Yes";
          no.textContent = "No";
          for (const [b, k] of [
            [yes, "y"],
            [no, "n"],
          ] as const) {
            b.type = "button";
            b.className = "zen-yn";
            b.addEventListener("pointerdown", (e) => e.preventDefault());
            b.addEventListener("click", () => this.onPromptKey({ key: k, ctrl: false, alt: false, shift: false, meta: false }));
            el.querySelector(".zen-prompt-field")!.appendChild(b);
          }
        }
      }
      el.querySelector(".zen-prompt-label")!.textContent = label;
      el.querySelector(".zen-badge")!.textContent = badge;
      return;
    }
    delete el.dataset.kind;
    const now = performance.now();
    if (this.status && this.status.until > now) {
      el.className = "zen-status" + (this.status.error ? " error" : " info");
      el.textContent = this.status.text;
      return;
    }
    this.status = null;
    el.className = "zen-status";
    if (!d) {
      el.textContent = "";
      return;
    }
    const line = d.buf.lines[d.cy];
    const parts = [
      `Ln ${d.cy + 1}, Col ${displayCol(line, d.cx) + 1}`,
      d.buf.lineEnding,
      d.highlighter.name,
    ];
    const sel = this.selection();
    if (sel) parts.unshift(describe(d.buf.textRange(sel[0], sel[1])) + " selected");
    el.innerHTML = `<span class="zen-path"></span><span class="zen-pos"></span>`;
    el.firstElementChild!.textContent = d.path + (d.dirty ? " · modified" : "");
    el.lastElementChild!.textContent = parts.join("  ·  ");
  }
}


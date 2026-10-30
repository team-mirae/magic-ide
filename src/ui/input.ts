// Text input that survives every IME, shared by the editor and the terminal.
//
// Typing goes into a hidden textarea that always holds the text around the
// caret, so predictive keyboards (Samsung's hybrid QWERTY/Korean keyboard,
// Gboard, iOS) see real context and backspace always has something to
// delete. After each input event, and when a composition ends, the
// textarea is compared with what we put in it, and the difference is
// handed to the host as one edit: delete N graphemes before the caret,
// M after, then insert some text. While a composition is running the
// textarea is left alone and its uncommitted text is shown as a preedit.
//
// This works the same whether the IME commits per syllable (Korean 2-set
// on desktop), per word (Gboard and Samsung Korean, predictive English),
// or after a conversion step (Japanese かな → 漢字, Enter to commit), and
// whether Enter and Backspace arrive as keys or as input events.
//
// Keys that aren't text (arrows, shortcuts) are handled on keydown, except
// while composing, when they belong to the IME.

import { graphemeCount, graphemes } from "../zencode/text";
import { fromEvent, isText, key, sticky, type Key } from "./keys";

export interface Edit {
  /** Graphemes to delete before the caret. */
  deleteBefore: number;
  /** Graphemes to delete after the caret. */
  deleteAfter: number;
  insert: string;
}

export interface InputHost {
  /** Text on either side of the caret, as the IME should see it. */
  context(): { before: string; after: string };
  /** Apply text typed through the keyboard or IME. */
  apply(edit: Edit): void;
  /** A key that isn't plain text. Return true if it was used. */
  key(k: Key): boolean;
  /** Uncommitted composition text to draw at the caret ("" when none). */
  preedit(text: string): void;
}

/** How much context to give the IME; enough for predictions, small enough to diff on every key. */
const CONTEXT = 120;

/** Diff the textarea against what we put in it, relative to where the caret was. */
export function diff(base: string, caret: number, cur: string, newCaret: number): Edit | null {
  if (base === cur) return null;
  let suffix = 0;
  const maxSuffix = Math.min(base.length, cur.length, cur.length - newCaret, base.length - Math.min(caret, base.length));
  while (suffix < maxSuffix && base[base.length - 1 - suffix] === cur[cur.length - 1 - suffix]) suffix++;
  let prefix = 0;
  const maxPrefix = Math.min(base.length, cur.length) - suffix;
  while (prefix < maxPrefix && base[prefix] === cur[prefix]) prefix++;
  // Never split a surrogate pair.
  if (prefix > 0 && /[\uD800-\uDBFF]/.test(base[prefix - 1])) prefix--;
  const delEnd = base.length - suffix;
  const insert = cur.slice(prefix, cur.length - suffix);
  const deleteBefore = prefix < caret ? graphemeCount(base.slice(prefix, Math.min(caret, delEnd))) : 0;
  const deleteAfter = delEnd > caret ? graphemeCount(base.slice(Math.max(caret, prefix), delEnd)) : 0;
  if (!deleteBefore && !deleteAfter && !insert) return null;
  return { deleteBefore, deleteAfter, insert };
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  const gs = graphemes(s);
  let out = "";
  for (let i = gs.length - 1; i >= 0 && out.length + gs[i].length <= n; i--) out = gs[i] + out;
  return out;
}

function head(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  for (const g of graphemes(s)) {
    if (out.length + g.length > n) break;
    out += g;
  }
  return out;
}

/** The sink that last had focus; the on-screen key bar types into it. */
let active: InputSink | null = null;

export function activeSink(): InputSink | null {
  return active;
}

export class InputSink {
  readonly el: HTMLTextAreaElement;
  private composing = false;
  private base = "";
  private caret = 0;
  /** A keydown we handled; its default input (if the browser does one anyway) must be dropped. */
  private swallow = false;
  private cleanup: (() => void)[] = [];

  constructor(private host: InputHost, el?: HTMLTextAreaElement) {
    this.el = el ?? document.createElement("textarea");
    const t = this.el;
    t.className ||= "input-sink";
    t.setAttribute("autocapitalize", "off");
    t.setAttribute("autocomplete", "off");
    t.setAttribute("autocorrect", "off");
    t.setAttribute("spellcheck", "false");
    t.setAttribute("aria-multiline", "true");
    t.tabIndex = 0;

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on("focus", () => {
      active = this;
      this.sync();
    });
    on("keydown", (e) => this.onKeydown(e));
    // The swallowed default belongs to the key's own keydown..keyup.
    on("keyup", () => (this.swallow = false));
    on("beforeinput", (e) => {
      if (this.swallow && !e.isComposing) e.preventDefault();
    });
    on("input", (e) => {
      if ((e as InputEvent).isComposing || this.composing) {
        this.showPreedit();
        return;
      }
      this.flush();
    });
    on("compositionstart", () => {
      this.swallow = false;
      // Anything typed just before the composition began is committed first.
      this.flush();
      this.composing = true;
    });
    on("compositionupdate", () => queueMicrotask(() => this.showPreedit()));
    on("compositionend", () => {
      this.composing = false;
      // Chrome has already applied the final text; Safari applies it in
      // the input event that follows. Flushing both times is harmless.
      this.flush();
      setTimeout(() => this.flush(), 0);
    });
    on("blur", () => {
      if (this.composing) {
        this.composing = false;
        this.flush();
      }
      this.host.preedit("");
    });
    // Gboard and iOS move the caret by swiping the space bar; follow it.
    const onSelection = () => {
      if (document.activeElement !== t || this.composing || t.value !== this.base) return;
      if (t.selectionStart !== t.selectionEnd || t.selectionStart === this.caret) return;
      const from = Math.min(this.caret, t.selectionStart);
      const to = Math.max(this.caret, t.selectionStart);
      const n = graphemeCount(t.value.slice(from, to));
      const k = key(t.selectionStart < this.caret ? "ArrowLeft" : "ArrowRight");
      for (let i = 0; i < n; i++) this.host.key(k);
      this.sync();
    };
    document.addEventListener("selectionchange", onSelection);
    this.cleanup.push(() => document.removeEventListener("selectionchange", onSelection));
  }

  get isComposing(): boolean {
    return this.composing;
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  /** Put the current context into the textarea. Skipped mid-composition, which would cancel it. */
  sync(): void {
    if (this.composing) return;
    const { before, after } = this.host.context();
    const b = tail(before, CONTEXT);
    const a = head(after, CONTEXT / 4);
    this.base = b + a;
    this.caret = b.length;
    if (this.el.value !== this.base) this.el.value = this.base;
    if (document.activeElement === this.el) this.el.setSelectionRange(this.caret, this.caret);
  }

  /** End any composition now, committing its text, e.g. before the caret is moved by a tap. */
  commit(): void {
    if (!this.composing) return;
    this.el.blur();
    this.composing = false;
    this.flush();
    this.focus();
  }

  /** Send a key from the on-screen key bar, with any sticky modifiers. */
  press(k: Key): void {
    this.commit();
    if (this.host.key(sticky.consume(k))) this.sync();
  }

  private showPreedit(): void {
    if (!this.composing) return this.host.preedit("");
    const e = diff(this.base, this.caret, this.el.value, this.el.selectionEnd ?? this.el.value.length);
    this.host.preedit(e?.insert ?? "");
  }

  private flush(): void {
    if (this.composing) return;
    const e = diff(this.base, this.caret, this.el.value, this.el.selectionEnd ?? this.el.value.length);
    if (e) {
      this.host.preedit("");
      // A character typed on the soft keyboard while ⌃ / ⌥ is held on the key bar is a shortcut.
      const chars = [...e.insert];
      if (sticky.any() && chars.length === 1 && !e.deleteBefore && !e.deleteAfter && e.insert !== "\n") {
        this.host.key(sticky.consume(key(e.insert)));
      } else {
        this.host.apply(e);
      }
    }
    this.sync();
  }

  private onKeydown(e: KeyboardEvent): void {
    this.swallow = false;
    // Keys during a composition belong to the IME. Android reports every
    // soft key as 229; those arrive through input events instead.
    if (e.isComposing || this.composing || e.keyCode === 229) return;
    const k = fromEvent(e);
    if (!k) return;
    if (isText(k) && !sticky.any()) return;
    if (this.host.key(sticky.consume(k))) {
      e.preventDefault();
      this.swallow = true;
      this.sync();
    }
  }

  dispose(): void {
    for (const f of this.cleanup) f();
    if (active === this) active = null;
  }
}

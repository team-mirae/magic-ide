// A keyboard robot: plays the DOM events a real keyboard and IME produce
// on a textarea, including the browser's default edits when a key isn't
// handled. Each IME profile below reproduces the event order of a real
// keyboard, as observed in Chrome and Safari.

type Order = "chrome" | "safari";

export class Robot {
  /** Where the current composition's text starts and ends in the textarea. */
  private comp: { start: number; end: number } | null = null;

  constructor(
    readonly el: HTMLTextAreaElement,
    private order: Order = "chrome",
  ) {}

  private fireKey(type: "keydown" | "keyup", key: string, opts: { code?: string; keyCode?: number; composing?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): KeyboardEvent {
    const e = new KeyboardEvent(type, {
      key,
      code: opts.code ?? "",
      bubbles: true,
      cancelable: true,
      isComposing: opts.composing ?? false,
      ctrlKey: opts.ctrl,
      shiftKey: opts.shift,
      altKey: opts.alt,
      metaKey: opts.meta,
    });
    Object.defineProperty(e, "keyCode", { value: opts.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0) });
    this.el.dispatchEvent(e);
    return e;
  }

  private beforeInput(inputType: string, data: string | null, composing = false): boolean {
    const e = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: !composing, isComposing: composing });
    return this.el.dispatchEvent(e);
  }

  private input(inputType: string, data: string | null, composing = false): void {
    this.el.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, isComposing: composing }));
  }

  private replace(start: number, end: number, text: string): void {
    const v = this.el.value;
    this.el.value = v.slice(0, start) + text + v.slice(end);
    const caret = start + text.length;
    this.el.setSelectionRange(caret, caret);
  }

  // ----- plain keys (no IME, or an IME in direct mode) ---------------------------

  /** A character key on a hardware keyboard. */
  char(ch: string): void {
    const kd = this.fireKey("keydown", ch, { code: /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : "" });
    if (!kd.defaultPrevented && this.beforeInput("insertText", ch)) {
      this.replace(this.el.selectionStart, this.el.selectionEnd, ch);
      this.input("insertText", ch);
    }
    this.fireKey("keyup", ch);
  }

  text(s: string): void {
    for (const ch of s) this.char(ch);
  }

  /** A special key; unhandled Backspace / Delete / Enter do what a textarea does. */
  key(name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; keyCode?: number } = {}): void {
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const kd = this.fireKey("keydown", name, { ...mods, code, keyCode: mods.keyCode ?? { Backspace: 8, Enter: 13, Tab: 9, Delete: 46 }[name] ?? 0 });
    if (!kd.defaultPrevented) this.defaultFor(name);
    this.fireKey("keyup", name, { code });
  }

  private defaultFor(name: string): void {
    const s = this.el.selectionStart;
    const e = this.el.selectionEnd;
    if (name === "Backspace" && this.beforeInput("deleteContentBackward", null)) {
      if (s !== e) this.replace(s, e, "");
      else if (s > 0) this.replace(s - 1, s, "");
      this.input("deleteContentBackward", null);
    } else if (name === "Delete" && this.beforeInput("deleteContentForward", null)) {
      this.replace(s, s === e ? s + 1 : e, "");
      this.input("deleteContentForward", null);
    } else if (name === "Enter" && this.beforeInput("insertLineBreak", null)) {
      this.replace(s, e, "\n");
      this.input("insertLineBreak", null);
    }
  }

  // ----- soft keyboards: every key is 229 ---------------------------------------------

  /** Android soft key outside a composition: keydown 229, then the edit as an input event. */
  softChar(ch: string): void {
    this.fireKey("keydown", "Unidentified", { keyCode: 229 });
    if (this.beforeInput("insertText", ch)) {
      this.replace(this.el.selectionStart, this.el.selectionEnd, ch);
      this.input("insertText", ch);
    }
    this.fireKey("keyup", "Unidentified", { keyCode: 229 });
  }

  softBackspace(): void {
    this.fireKey("keydown", "Unidentified", { keyCode: 229 });
    this.defaultFor("Backspace");
  }

  /** Enter sent as text, as some Android keyboards do. */
  softEnter(): void {
    this.fireKey("keydown", "Unidentified", { keyCode: 229 });
    this.defaultFor("Enter");
  }

  // ----- compositions ------------------------------------------------------------------

  /** Begin a composition at the caret, or over existing text (Gboard re-composing a word). */
  compStart(region?: { start: number; end: number }): void {
    const start = region?.start ?? this.el.selectionStart;
    const end = region?.end ?? this.el.selectionEnd;
    this.comp = { start, end };
    this.el.dispatchEvent(new CompositionEvent("compositionstart", { data: this.el.value.slice(start, end), bubbles: true }));
  }

  /** The IME replaces its staged text with `text`. */
  compUpdate(text: string, keydown = true): void {
    const c = this.comp!;
    if (keydown) this.fireKey("keydown", "Process", { keyCode: 229, composing: true });
    this.beforeInput("insertCompositionText", text, true);
    this.replace(c.start, c.end, text);
    c.end = c.start + text.length;
    this.el.dispatchEvent(new CompositionEvent("compositionupdate", { data: text, bubbles: true }));
    this.input("insertCompositionText", text, true);
  }

  /** Commit the staged text as `text` (defaults to what is staged). */
  compEnd(text?: string): void {
    const c = this.comp!;
    const final = text ?? this.el.value.slice(c.start, c.end);
    this.comp = null;
    if (this.order === "chrome") {
      // Chrome: the final text lands while still composing, then compositionend.
      this.beforeInput("insertCompositionText", final, true);
      this.replace(c.start, c.end, final);
      this.input("insertCompositionText", final, true);
      this.el.dispatchEvent(new CompositionEvent("compositionend", { data: final, bubbles: true }));
    } else {
      // Safari: compositionend first, then a non-composing input with the text.
      this.el.dispatchEvent(new CompositionEvent("compositionend", { data: final, bubbles: true }));
      this.replace(c.start, c.end, final);
      this.input("insertFromComposition", final, false);
    }
  }

  /** Enter pressed while composing: belongs to the IME, which commits. */
  composingEnter(): void {
    this.fireKey("keydown", "Enter", { keyCode: 229, composing: true });
    this.compEnd();
  }

  // ----- IME profiles --------------------------------------------------------------------

  /**
   * JIS romaji-English hybrid keyboards: English stays staged (underlined,
   * uncommitted) while it is typed, and the IME rewrites the whole staged
   * run on every key: "s", "su", "suc", … "such as". Enter commits.
   */
  jisHybridStaged(s: string): void {
    this.compStart();
    let staged = "";
    for (const ch of s) {
      staged += ch;
      this.compUpdate(staged);
    }
    this.composingEnter();
  }

  /** Korean 2-set on desktop: each syllable is its own composition, built jamo by jamo. */
  korean2Set(steps: string[][]): void {
    for (const syllable of steps) {
      this.compStart();
      for (const s of syllable) this.compUpdate(s);
      this.compEnd();
    }
  }

  /**
   * Samsung's US/Korean hybrid keyboard: predictive English and Korean
   * words are both staged as one composition per word, and space commits
   * the word, then types the space outside the composition.
   */
  samsungWord(stages: string[], commit = stages[stages.length - 1]): void {
    this.compStart();
    for (const s of stages) this.compUpdate(s, false);
    this.compEnd(commit);
    this.softChar(" ");
  }
}

/** "such as" → ["s", "su", "suc", "such", "such ", "such a", "such as"]. */
export function prefixes(s: string): string[] {
  const out: string[] = [];
  let acc = "";
  for (const ch of s) out.push((acc += ch));
  return out;
}

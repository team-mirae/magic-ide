// Keys, normalized so every OS, keyboard layout and the on-screen key bar
// look the same to the editor and the terminal.
//
// - Letters with ⌃ / ⌥ / ⌘ are read from the physical key (`code`), so ⌥E
//   on macOS isn't a dead key, and ⌃C still works with the Korean or
//   Japanese IME switched on.
// - Mobile keyboards have no Tab, arrows or modifiers, so the key bar
//   offers them, with ⌃ ⌥ ⇧ as sticky modifiers that apply to the next key
//   or the next character typed on the soft keyboard.

export interface Key {
  /** KeyboardEvent.key names for special keys ("ArrowLeft", "Backspace"), the lowercase letter for letters with modifiers, else the character. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export function key(name: string, mods: Partial<Omit<Key, "key">> = {}): Key {
  return { key: name, ctrl: false, alt: false, shift: false, meta: false, ...mods };
}

const CODE_CHARS: Record<string, string> = {
  Slash: "/",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Space: " ",
};

export function fromEvent(e: KeyboardEvent): Key | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process", "Unidentified"].includes(e.key) && !(e.altKey && e.key === "Dead")) {
    return null;
  }
  // AltGr on Windows / Linux reports ⌃⌥; it's a way of typing characters, not a shortcut.
  const altGr = e.getModifierState?.("AltGraph") ?? false;
  const k: Key = {
    key: e.key,
    ctrl: e.ctrlKey && !altGr,
    alt: e.altKey && !altGr,
    shift: e.shiftKey,
    meta: e.metaKey,
  };
  if (k.ctrl || k.alt || k.meta) {
    const letter = /^Key([A-Z])$/.exec(e.code);
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (letter) k.key = letter[1].toLowerCase();
    else if (digit) k.key = digit[1];
    else if (e.code in CODE_CHARS) k.key = CODE_CHARS[e.code];
  }
  return k;
}

/** A single printable character with no command modifier: text, not a shortcut. */
export function isText(k: Key): boolean {
  return [...k.key].length === 1 && !k.ctrl && !k.meta && !k.alt;
}

// ----- sticky modifiers ---------------------------------------------------------

type Mod = "ctrl" | "alt" | "shift";

class Sticky {
  private on = new Set<Mod>();
  onChange: () => void = () => {};

  toggle(m: Mod): void {
    if (this.on.has(m)) this.on.delete(m);
    else this.on.add(m);
    this.onChange();
  }

  has(m: Mod): boolean {
    return this.on.has(m);
  }

  any(): boolean {
    return this.on.size > 0;
  }

  /** Apply the held modifiers to `k` and release them. */
  consume(k: Key): Key {
    if (!this.on.size) return k;
    const out = { ...k, ctrl: k.ctrl || this.on.has("ctrl"), alt: k.alt || this.on.has("alt"), shift: k.shift || this.on.has("shift") };
    if ([...out.key].length === 1 && (out.ctrl || out.alt)) out.key = out.key.toLowerCase();
    this.on.clear();
    this.onChange();
    return out;
  }
}

export const sticky = new Sticky();

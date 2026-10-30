// On-screen keys for touch devices, whose keyboards have no Esc, Tab,
// arrows or modifiers. ⌃ ⌥ ⇧ are sticky: they apply to the next key here
// or the next character typed on the soft keyboard (⌃ then "c" is ⌃C).
// Every button keeps focus where it is, so the soft keyboard stays open.

import { activeSink, type InputSink } from "./input";
import { key, sticky, type Key } from "./keys";

const extras = new WeakMap<InputSink, { label: string; key: Key }[]>();

/** Extra buttons shown while `sink` has focus, e.g. ⌃C for the terminal. */
export function setExtraKeys(sink: InputSink, keys: { label: string; key: Key }[]): void {
  extras.set(sink, keys);
}

interface Item {
  label: string;
  title: string;
  key?: Key;
  mod?: "ctrl" | "alt" | "shift";
}

const BASE: Item[] = [
  { label: "Esc", title: "Escape", key: key("Escape") },
  { label: "Tab", title: "Tab", key: key("Tab") },
  { label: "⌃", title: "Control (sticky)", mod: "ctrl" },
  { label: "⌥", title: "Option / Alt (sticky)", mod: "alt" },
  { label: "⇧", title: "Shift (sticky)", mod: "shift" },
  { label: "←", title: "Left", key: key("ArrowLeft") },
  { label: "↑", title: "Up", key: key("ArrowUp") },
  { label: "↓", title: "Down", key: key("ArrowDown") },
  { label: "→", title: "Right", key: key("ArrowRight") },
  { label: "Home", title: "Home", key: key("Home") },
  { label: "End", title: "End", key: key("End") },
];

export function createKeyBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "keybar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "On-screen keys");

  const render = () => {
    bar.innerHTML = "";
    const sink = activeSink();
    // Extras first: on a narrow screen the end of the bar scrolls off.
    const items: Item[] = [...(sink ? (extras.get(sink) ?? []).map((e) => ({ label: e.label, title: e.label, key: e.key })) : []), ...BASE];
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      b.title = item.title;
      if (item.mod) {
        b.classList.add("mod");
        b.setAttribute("aria-pressed", String(sticky.has(item.mod)));
      }
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        if (item.mod) return sticky.toggle(item.mod);
        const s = activeSink();
        if (s && item.key) s.press(item.key);
      });
      bar.appendChild(b);
    }
  };
  // Only useful while something takes typing: the editor, terminal or a prompt.
  const sync = () => {
    const a = document.activeElement;
    bar.classList.toggle("idle", !(a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement));
  };
  sticky.onChange = render;
  document.addEventListener("focusin", () => {
    render();
    sync();
  });
  document.addEventListener("focusout", () => setTimeout(sync, 0));
  sync();
  render();
  return bar;
}

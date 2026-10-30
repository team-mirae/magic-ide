// Keyboard robots typing into the VENV terminal (and the editor), one per
// IME family. The golden case is the JIS romaji-English hybrid keyboard:
// staged, uncommitted English that the IME rewrites on every key. Web
// terminals commonly commit each rewrite, producing
// "such as such as t such as th such as thi…"; every robot here checks
// that each word lands exactly once.

import { beforeEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/plugins/registry";
import { Terminal } from "../src/ui/terminal";
import { sticky } from "../src/ui/keys";
import { Robot, prefixes } from "./robot";

function mount(order: "chrome" | "safari" = "chrome") {
  document.body.innerHTML = "";
  const term = new Terminal({
    fs: () => null,
    plugins: new PluginRegistry(),
    open: () => {},
    changed: () => {},
    workspaces: async () => {},
  });
  document.body.appendChild(term.root);
  term.focus();
  return { term, robot: new Robot(term.input.el, order) };
}

/** How many times the shell echoed `line` as a submitted command. */
function echoed(term: Terminal, line: string): number {
  return term.output.split("\n").filter((l) => l === `/ $ ${line}`).length;
}

beforeEach(() => {
  // Make sure no sticky modifier leaks between tests.
  while (sticky.any()) sticky.consume({ key: "x", ctrl: false, alt: false, shift: false, meta: false });
});

describe.each(["chrome", "safari"] as const)("JIS romaji-English hybrid (%s)", (order) => {
  it("commits a staged English run once", () => {
    const { term, robot } = mount(order);
    robot.jisHybridStaged("such as");
    expect(term.currentLine).toBe("such as");
  });

  it("never commits while staging, so no 'such as such as t…' cascade", () => {
    const { term, robot } = mount(order);
    robot.compStart();
    for (const staged of prefixes("such as this")) {
      robot.compUpdate(staged);
      // Nothing is committed to the line while the text is staged.
      expect(term.currentLine).toBe("");
    }
    robot.composingEnter();
    expect(term.currentLine).toBe("such as this");
  });

  it("chains staged runs after committed text and submits each line once", () => {
    const { term, robot } = mount(order);
    robot.jisHybridStaged("such as");
    robot.jisHybridStaged(" the quick");
    robot.text(" brown");
    robot.jisHybridStaged(" fox");
    expect(term.currentLine).toBe("such as the quick brown fox");
    robot.key("Enter");
    expect(term.currentLine).toBe("");
    expect(echoed(term, "such as the quick brown fox")).toBe(1);
    expect(term.output).not.toContain("such as such as");
  });

  it("Enter during staging commits without submitting", () => {
    const { term, robot } = mount(order);
    robot.jisHybridStaged("echo hi");
    expect(echoed(term, "echo hi")).toBe(0);
    robot.key("Enter");
    expect(echoed(term, "echo hi")).toBe(1);
    expect(term.output).toContain("hi\n");
  });

  it("stages in the middle of a line", () => {
    const { term, robot } = mount(order);
    robot.text("echo  done");
    for (let i = 0; i < 5; i++) robot.key("ArrowLeft");
    robot.jisHybridStaged("such as");
    expect(term.currentLine).toBe("echo such as done");
  });

  it("backspace while staged is the IME's, after commit it is ours", () => {
    const { term, robot } = mount(order);
    robot.compStart();
    for (const s of prefixes("such az")) robot.compUpdate(s);
    robot.compUpdate("such a");
    robot.compUpdate("such as");
    robot.composingEnter();
    expect(term.currentLine).toBe("such as");
    robot.key("Backspace");
    robot.key("Backspace");
    expect(term.currentLine).toBe("such ");
  });

  it("re-typed repeated words stay distinct", () => {
    const { term, robot } = mount(order);
    for (let i = 0; i < 4; i++) robot.jisHybridStaged("such as ");
    expect(term.currentLine).toBe("such as such as such as such as ");
  });

  it("Japanese compose, convert, commit", () => {
    const { term, robot } = mount(order);
    robot.compStart();
    for (const s of ["n", "に", "にh", "にほ", "にほn", "にほん", "にほんg", "にほんご"]) robot.compUpdate(s);
    robot.compUpdate("日本語");
    robot.composingEnter();
    expect(term.currentLine).toBe("日本語");
  });
});

describe.each(["chrome", "safari"] as const)("Korean 2-set (KTS) on desktop (%s)", (order) => {
  it("composes per syllable", () => {
    const { term, robot } = mount(order);
    robot.korean2Set([
      ["ㅎ", "하", "한"],
      ["ㄱ", "그", "글"],
    ]);
    expect(term.currentLine).toBe("한글");
  });

  it("mixes English keys and Korean syllables", () => {
    const { term, robot } = mount(order);
    robot.text("echo ");
    robot.korean2Set([["ㅇ", "아", "안"], ["ㄴ", "녀", "녕"]]);
    robot.key("Enter");
    expect(echoed(term, "echo 안녕")).toBe(1);
    expect(term.output).toContain("안녕\n");
  });
});

describe.each(["chrome", "safari"] as const)("Samsung US/Korean hybrid (%s)", (order) => {
  it("stages predictive English and Korean words, space commits each", () => {
    const { term, robot } = mount(order);
    robot.samsungWord(prefixes("echo"));
    robot.samsungWord(["ㅇ", "아", "안", "안ㄴ", "안녀", "안녕"]);
    robot.samsungWord(prefixes("such"));
    robot.samsungWord(prefixes("as"));
    expect(term.currentLine).toBe("echo 안녕 such as ");
  });

  it("autocorrect rewrites the staged word on commit", () => {
    const { term, robot } = mount(order);
    robot.samsungWord(prefixes("teh"), "the");
    expect(term.currentLine).toBe("the ");
  });

  it("soft backspace with keyCode 229, and backspace re-composing a word", () => {
    const { term, robot } = mount(order);
    robot.samsungWord(prefixes("hello"));
    robot.softBackspace();
    expect(term.currentLine).toBe("hello");
    // Backspacing into the word re-opens it as a composition.
    const el = robot.el;
    const end = el.value.length;
    robot.compStart({ start: end - 5, end });
    robot.compUpdate("hell", false);
    robot.compEnd();
    expect(term.currentLine).toBe("hell");
  });

  it("Enter as a key and Enter as text both submit once, with typeahead", async () => {
    const { term, robot } = mount(order);
    robot.samsungWord(prefixes("echo"));
    robot.samsungWord(prefixes("one"));
    robot.key("Enter", { keyCode: 13 });
    robot.samsungWord(prefixes("echo"));
    robot.samsungWord(prefixes("two"));
    robot.softEnter();
    // The second line was typed ahead while the first ran; let both finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(echoed(term, "echo one ")).toBe(1);
    expect(echoed(term, "echo two ")).toBe(1);
  });
});

describe("on-screen key bar", () => {
  it("sticky ⌃ then a soft 'c' interrupts", () => {
    const { term, robot } = mount();
    robot.samsungWord(prefixes("sleep"));
    sticky.toggle("ctrl");
    robot.softChar("c");
    expect(term.currentLine).toBe("");
    expect(term.output).toContain("sleep ^C");
  });

  it("Tab and arrows from the bar", () => {
    const { term } = mount();
    term.input.press({ key: "ArrowUp", ctrl: false, alt: false, shift: false, meta: false });
    expect(term.currentLine).toBe("");
  });
});

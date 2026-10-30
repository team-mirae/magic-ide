// Letterblocks, ported from zencode's letterblock.rs (KEYBINDS.md
// "Letterblock deletion"). A letterblock is a block of text with its own
// meaning: a word in English, a run of one script in Japanese
// (あなたの|ギター|になりたい|！), and in Korean a stem with its particle or
// ending split off (학교|에서는, 먹|었습니다).
//
// The Korean split uses a short list of common particles and endings,
// checked against the syllable before them, and has no dictionary.

import { graphemes } from "./text";

export interface Range {
  start: number;
  end: number;
}

enum Class {
  Space,
  Latin,
  Hangul,
  Han,
  Hiragana,
  Katakana,
  Punct,
}

function classOf(g: string): Class {
  const c = g.codePointAt(0);
  if (c === undefined || /\s/u.test(g[0])) return Class.Space;
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) {
    return Class.Hangul;
  }
  if (c >= 0x3040 && c <= 0x309f) return Class.Hiragana;
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) {
    return Class.Katakana;
  }
  if (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    g[0] === "々"
  ) {
    return Class.Han;
  }
  if (g[0] === "_" || /[\p{L}\p{N}]/u.test(g)) return Class.Latin;
  return Class.Punct;
}

/** What the syllable before a suffix must end in for the split to apply. */
enum After {
  Any,
  Consonant,
  Vowel,
  VowelOrRieul,
}

const C = After.Consonant;
const V = After.Vowel;
const R = After.VowelOrRieul;
const A = After.Any;

// prettier-ignore
const SUFFIXES: [string, After][] = [
  ["은", C], ["을", C], ["이", C], ["과", C],
  ["이랑", C], ["이나", C], ["이라도", C], ["이야", C],
  ["이며", C], ["이든지", C], ["과는", C], ["이라고", C],
  ["이라는", C], ["으로", C], ["으로서", C], ["으로써", C],
  ["으로부터", C], ["으로는", C],
  ["는", V], ["를", V], ["가", V], ["와", V], ["랑", V],
  ["나", V], ["라도", V], ["야", V], ["며", V], ["든지", V],
  ["와는", V], ["라고", V], ["라는", V],
  ["로", R], ["로서", R], ["로써", R],
  ["로부터", R], ["로는", R],
  ["의", A], ["에", A], ["께", A], ["도", A], ["만", A], ["뿐", A],
  ["에서", A], ["에게", A], ["에게서", A], ["한테", A], ["한테서", A],
  ["께서", A], ["까지", A], ["부터", A], ["마저", A], ["조차", A],
  ["보다", A], ["처럼", A], ["같이", A], ["만큼", A], ["밖에", A],
  ["대로", A], ["에는", A], ["에서는", A], ["에게는", A], ["에도", A],
  ["에서도", A], ["까지는", A], ["까지도", A], ["부터는", A], ["만은", A],
  ["습니다", A], ["었습니다", A], ["았습니다", A], ["였습니다", A],
  ["했습니다", A], ["겠습니다", A], ["습니까", A], ["입니다", A],
  ["입니까", A], ["합니다", A], ["합니까", A], ["됩니다", A],
  ["이에요", A], ["예요", A], ["이었다", A], ["였다", A], ["었다", A],
  ["았다", A], ["했다", A], ["겠다", A], ["한다", A], ["하다", A],
  ["하는", A], ["하고", A], ["해서", A], ["하면", A], ["해요", A],
  ["했어요", A], ["었어요", A], ["았어요", A], ["겠어요", A], ["어요", A],
  ["아요", A], ["하던", A], ["었던", A], ["았던", A], ["된다", A],
  ["되다", A], ["되는", A], ["됐다", A], ["돼요", A], ["지만", A],
  ["는데", A], ["은데", A], ["니까", A], ["으니까", A], ["어서", A],
  ["아서", A], ["면서", A], ["으면서", A], ["으면", A], ["려고", A],
  ["으려고", A], ["도록", A], ["세요", A], ["으세요", A], ["십시오", A],
];

const SUFFIX_SET = new Set(SUFFIXES.map(([s]) => s));

/** Final consonant index of a Hangul syllable (0 = none). */
function finalConsonant(c: string): number | undefined {
  const s = c.codePointAt(0)! - 0xac00;
  return s >= 0 && s < 11_172 ? s % 28 : undefined;
}

/** Where to split a Hangul run into stem and suffix, if anywhere. */
function koreanSplit(run: string[]): number | undefined {
  const whole = run.join("");
  if (SUFFIX_SET.has(whole)) return undefined;
  let best: { stem: number; n: number } | undefined;
  for (const [suffix, after] of SUFFIXES) {
    const n = [...suffix].length;
    const stem = run.length - n;
    if (stem <= 0) continue;
    if (run.slice(stem).join("") !== suffix) continue;
    // A one-syllable ending after a one-syllable stem is more often part
    // of the word itself (사과, 가을).
    if (after === After.Any && n === 1 && stem < 2) continue;
    if (SUFFIX_SET.has(run.slice(0, stem).join(""))) continue;
    const fin = finalConsonant(run[stem - 1]);
    let fits: boolean;
    switch (after) {
      case After.Any:
        fits = true;
        break;
      case After.Consonant:
        fits = fin !== undefined && fin !== 0;
        break;
      case After.Vowel:
        fits = fin === 0;
        break;
      case After.VowelOrRieul:
        fits = fin === 0 || fin === 8;
        break;
    }
    if (fits && (!best || n > best.n)) best = { stem, n };
  }
  return best?.stem;
}

/** Every letterblock in `s`, as grapheme ranges. Spaces belong to none. */
export function blocks(s: string): Range[] {
  const gs = graphemes(s);
  const classes = gs.map(classOf);
  const out: Range[] = [];
  let i = 0;
  while (i < gs.length) {
    const c = classes[i];
    let j = i + 1;
    while (j < gs.length && classes[j] === c) j++;
    if (c === Class.Hangul) {
      const run = gs.slice(i, j).map((g) => [...g][0]);
      const stem = koreanSplit(run);
      if (stem !== undefined) {
        out.push({ start: i, end: i + stem }, { start: i + stem, end: j });
      } else {
        out.push({ start: i, end: j });
      }
    } else if (c !== Class.Space) {
      out.push({ start: i, end: j });
    }
    i = j;
  }
  return out;
}

/** End of the first letterblock that ends after `gidx`. */
export function right(s: string, gidx: number): number {
  const b = blocks(s).find((b) => b.end > gidx);
  return b ? b.end : graphemes(s).length;
}

/** Start of the last letterblock that starts before `gidx`. */
export function left(s: string, gidx: number): number {
  const bs = blocks(s);
  for (let i = bs.length - 1; i >= 0; i--) if (bs[i].start < gidx) return bs[i].start;
  return 0;
}

/** The letterblock under `gidx`, or the run of spaces it sits in. */
export function blockAt(s: string, gidx: number): Range {
  const len = graphemes(s).length;
  gidx = Math.min(gidx, Math.max(0, len - 1));
  const bs = blocks(s);
  const hit = bs.find((b) => b.start <= gidx && gidx < b.end);
  if (hit) return { ...hit };
  let start = 0;
  for (let i = bs.length - 1; i >= 0; i--) {
    if (bs[i].end <= gidx) {
      start = bs[i].end;
      break;
    }
  }
  const next = bs.find((b) => b.start > gidx);
  return { start, end: next ? next.start : len };
}

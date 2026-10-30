// Search, ported from zencode's search.rs (KEYBINDS.md "Search contents").
//
// A strict search matches the query exactly. A permissive search also
// allows:
// - English: case-insensitive matching, and full-width ＡＢＣ matches ABC.
// - Korean: 초성 matching, so ㅎㄱ finds 한국. A trailing syllable without
//   a final consonant matches any final, so 한구 already finds 한국 while
//   you are still typing.
// - Japanese: ひらがな and カタカナ match each other.
//
// zencode also turns kana into kanji candidates with the inputx-nihongo
// dictionary; that dictionary isn't bundled here yet, so `candidates` is
// always empty.

import { graphemes } from "./text";

/** Stop collecting matches past this many, to keep huge files responsive. */
const MAX_MATCHES = 10_000;

/** A match on one line, as a grapheme range. */
export interface Match {
  row: number;
  start: number;
  end: number;
}

/** One position in a search pattern. */
type Atom =
  | { t: "char"; c: string }
  /** A bare initial consonant (ㄱ, ㄴ, …): matches any syllable that starts with it, or the jamo itself. */
  | { t: "initial"; i: number }
  /** A syllable without a final consonant: matches it with any final. */
  | { t: "open"; cho: number; jung: number };

/** The 19 initial consonants, as compatibility jamo (what keyboards type). */
const CHOSEONG = [..."ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"];

/** Split a precomposed Hangul syllable into [initial, medial, final]. Final 0 means none. */
function decompose(c: string): [number, number, number] | undefined {
  const s = c.codePointAt(0)! - 0xac00;
  if (s < 0 || s >= 11_172) return undefined;
  return [Math.floor(s / 588), Math.floor((s % 588) / 28), s % 28];
}

/** Normalize a char for permissive comparison: lowercase, full-width ASCII to half-width, katakana to hiragana. */
function fold(c: string): string {
  const n = c.codePointAt(0)!;
  if (n >= 0xff01 && n <= 0xff5e) c = String.fromCodePoint(n - 0xfee0);
  else if (n >= 0x30a1 && n <= 0x30f6) c = String.fromCodePoint(n - 0x60);
  const lower = c.toLowerCase();
  return [...lower].length === 1 ? lower : c;
}

function atomMatches(atom: Atom, c: string): boolean {
  switch (atom.t) {
    case "char":
      return atom.c === c;
    case "initial":
      return c === CHOSEONG[atom.i] || decompose(c)?.[0] === atom.i;
    case "open": {
      const d = decompose(c);
      return d !== undefined && d[0] === atom.cho && d[1] === atom.jung;
    }
  }
}

function permissiveAtoms(query: string): Atom[] {
  const chars = [...query].map(fold);
  const last = chars.length - 1;
  return chars.map((c, i): Atom => {
    const idx = CHOSEONG.indexOf(c);
    if (idx >= 0) return { t: "initial", i: idx };
    const d = decompose(c);
    if (d && d[2] === 0 && i === last) return { t: "open", cho: d[0], jung: d[1] };
    return { t: "char", c };
  });
}

export class Matcher {
  private exact: boolean;
  private patterns: Atom[][];
  /** Kanji spellings found for a kana query, for display. */
  candidates: string[] = [];

  constructor(query: string, exact: boolean) {
    this.exact = exact;
    this.patterns = exact ? [[...query].map((c) => ({ t: "char", c }))] : [permissiveAtoms(query)];
  }

  /** Every non-overlapping match in the buffer, in document order. Where several patterns match at one spot, the longest wins. */
  findAll(lines: string[]): Match[] {
    const out: Match[] = [];
    for (let row = 0; row < lines.length; row++) {
      // The line as (possibly folded) code points, each tagged with the
      // index of the grapheme it belongs to.
      const chars: string[] = [];
      const gidx: number[] = [];
      graphemes(lines[row]).forEach((g, gi) => {
        for (const c of g) {
          chars.push(this.exact ? c : fold(c));
          gidx.push(gi);
        }
      });
      let i = 0;
      while (i < chars.length) {
        let best = 0;
        for (const p of this.patterns) {
          if (p.length === 0 || i + p.length > chars.length) continue;
          if (p.every((a, k) => atomMatches(a, chars[i + k])) && p.length > best) best = p.length;
        }
        if (best === 0) {
          i++;
          continue;
        }
        out.push({ row, start: gidx[i], end: gidx[i + best - 1] + 1 });
        if (out.length >= MAX_MATCHES) return out;
        i += best;
      }
    }
    return out;
  }
}

// Display-width helpers, ported from zencode's text.rs. Everything is
// measured in grid cells, and zenkaku (full-width) characters such as 한글
// and 日本語 take two cells each. The cursor always moves by grapheme
// cluster, never by UTF-16 unit or code point, so combining marks and
// emoji sequences stay intact.

export const TAB_WIDTH = 4;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Splitting a line is the hot path for every keystroke; recent lines are
// cached so a run of edits on one line doesn't re-segment the whole buffer.
const cache = new Map<string, string[]>();
const CACHE_MAX = 2048;

export function graphemes(s: string): string[] {
  let gs = cache.get(s);
  if (gs) return gs;
  gs = Array.from(segmenter.segment(s), (x) => x.segment);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(s, gs);
  return gs;
}

export function graphemeCount(s: string): number {
  return graphemes(s).length;
}

/** UTF-16 offset of the `gidx`-th grapheme (or `s.length` past the end). */
export function codeIndex(s: string, gidx: number): number {
  const gs = graphemes(s);
  let i = 0;
  for (let g = 0; g < gidx && g < gs.length; g++) i += gs[g].length;
  return i;
}

/** Slice by grapheme indices. */
export function gslice(s: string, start: number, end?: number): string {
  return graphemes(s).slice(start, end).join("");
}

export function isControl(g: string): boolean {
  return g !== "\t" && /\p{Cc}/u.test(g);
}

const ZERO = /^[\p{Mn}\p{Me}​-‏⁠﻿]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

function wideCodePoint(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x231a && c <= 0x231b) ||
    (c >= 0x2329 && c <= 0x232a) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/**
 * Width of a grapheme that starts at display column `col`.
 * `col` only matters for tabs, which expand to the next tab stop.
 */
export function graphemeWidth(g: string, col: number): number {
  if (g === "\t") return TAB_WIDTH - (col % TAB_WIDTH);
  if (isControl(g)) return 1;
  if (ZERO.test(g)) return 0;
  const c = g.codePointAt(0)!;
  if (wideCodePoint(c)) return 2;
  if (PICTO.test(g) && (g.includes("️") || g.length > 2 || c >= 0x1f000)) return 2;
  return 1;
}

/** Total display width of `s`, assuming it starts at column 0. */
export function strWidth(s: string): number {
  let col = 0;
  for (const g of graphemes(s)) col += graphemeWidth(g, col);
  return col;
}

/** Display column at which the `gidx`-th grapheme starts. */
export function displayCol(s: string, gidx: number): number {
  const gs = graphemes(s);
  let col = 0;
  for (let i = 0; i < gidx && i < gs.length; i++) col += graphemeWidth(gs[i], col);
  return col;
}

/** Width of the grapheme at `gidx`, or 1 when the cursor sits past the end. */
export function widthAt(s: string, gidx: number): number {
  const gs = graphemes(s);
  if (gidx >= gs.length) return 1;
  return Math.max(1, graphemeWidth(gs[gidx], displayCol(s, gidx)));
}

/**
 * Grapheme index whose cell covers display column `target`; used to keep
 * the cursor in roughly the same column when moving between lines that
 * mix half-width and full-width text.
 */
export function gidxForCol(s: string, target: number): number {
  const gs = graphemes(s);
  let col = 0;
  for (let i = 0; i < gs.length; i++) {
    const w = graphemeWidth(gs[i], col);
    if (col + w > target) return i;
    col += w;
  }
  return gs.length;
}

/**
 * Grapheme boundary nearest to display column `col`: clicking the right
 * half of a full-width character puts the cursor after it.
 */
export function nearestBoundary(line: string, col: number): number {
  const gidx = gidxForCol(line, col);
  const start = displayCol(line, gidx);
  const w = widthAt(line, gidx);
  if (gidx < graphemeCount(line) && col - start >= Math.ceil(w / 2) && w > 1) return gidx + 1;
  return gidx;
}

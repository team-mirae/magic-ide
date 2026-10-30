// The text being edited: a list of lines plus file metadata, ported from
// zencode's buffer.rs. Positions are [row, grapheme index] pairs; ranges
// are half-open start..end with start <= end. Disk I/O lives in the
// workspace layer, not here.

import { codeIndex, graphemeCount, graphemes } from "./text";

export type Pos = [row: number, gidx: number];
export type LineEnding = "LF" | "CRLF";

export function posEq(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function posCmp(a: Pos, b: Pos): number {
  return a[0] - b[0] || a[1] - b[1];
}

export class Buffer {
  lines: string[];
  /** Bumped on every mutation, so callers can tell whether an edit actually changed anything. */
  revision = 0;
  lineEnding: LineEnding;

  constructor(content: string) {
    this.lineEnding = content.includes("\r\n") ? "CRLF" : "LF";
    const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    // A trailing newline terminates the last line rather than starting a new one.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    this.lines = lines;
  }

  /** The file contents to write, always ending in a newline like zencode does. */
  serialize(): string {
    const eol = this.lineEnding === "CRLF" ? "\r\n" : "\n";
    return this.lines.join(eol) + eol;
  }

  end(): Pos {
    const last = this.lines.length - 1;
    return [last, this.lineLen(last)];
  }

  lineLen(row: number): number {
    return graphemeCount(this.lines[row]);
  }

  /** Insert text (possibly spanning several lines) and return the position just after it. */
  insertStr(row: number, gidx: number, text: string): Pos {
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const line = this.lines[row];
    const at = codeIndex(line, gidx);
    const tail = line.slice(at);
    const parts = text.split("\n");
    this.lines[row] = line.slice(0, at) + parts[0];
    let r = row;
    for (const part of parts.slice(1)) {
      r++;
      this.lines.splice(r, 0, part);
    }
    const col = graphemeCount(this.lines[r]);
    this.lines[r] += tail;
    this.revision++;
    return [r, col];
  }

  /** Delete the grapheme before the cursor, joining lines at column 0. */
  backspace(row: number, gidx: number): Pos {
    if (gidx > 0) {
      const gs = graphemes(this.lines[row]);
      this.lines[row] = gs.slice(0, gidx - 1).join("") + gs.slice(gidx).join("");
      this.revision++;
      return [row, gidx - 1];
    }
    if (row > 0) {
      const [line] = this.lines.splice(row, 1);
      const col = graphemeCount(this.lines[row - 1]);
      this.lines[row - 1] += line;
      this.revision++;
      return [row - 1, col];
    }
    return [row, gidx];
  }

  /** Delete the grapheme under the cursor, joining with the next line at EOL. */
  delete(row: number, gidx: number): void {
    const gs = graphemes(this.lines[row]);
    if (gidx < gs.length) {
      this.lines[row] = gs.slice(0, gidx).join("") + gs.slice(gidx + 1).join("");
      this.revision++;
    } else if (row + 1 < this.lines.length) {
      const [next] = this.lines.splice(row + 1, 1);
      this.lines[row] += next;
      this.revision++;
    }
  }

  /** Text between two positions, with lines joined by `\n`. */
  textRange([r0, c0]: Pos, [r1, c1]: Pos): string {
    const b0 = codeIndex(this.lines[r0], c0);
    const b1 = codeIndex(this.lines[r1], c1);
    if (r0 === r1) return this.lines[r0].slice(b0, b1);
    return [this.lines[r0].slice(b0), ...this.lines.slice(r0 + 1, r1), this.lines[r1].slice(0, b1)].join("\n");
  }

  /** Delete everything between two positions. */
  deleteRange(start: Pos, end: Pos): void {
    if (posEq(start, end)) return;
    const [r0, c0] = start;
    const [r1, c1] = end;
    const b0 = codeIndex(this.lines[r0], c0);
    const b1 = codeIndex(this.lines[r1], c1);
    this.lines[r0] = this.lines[r0].slice(0, b0) + this.lines[r1].slice(b1);
    this.lines.splice(r0 + 1, r1 - r0);
    this.revision++;
  }

  /**
   * Swap the block of lines r0..=r1 with its neighbor above (`up`) or
   * below. Returns false when the block is already at the edge.
   */
  moveLines(r0: number, r1: number, up: boolean): boolean {
    if (up) {
      if (r0 === 0) return false;
      const [line] = this.lines.splice(r0 - 1, 1);
      this.lines.splice(r1, 0, line);
    } else {
      if (r1 + 1 >= this.lines.length) return false;
      const [line] = this.lines.splice(r1 + 1, 1);
      this.lines.splice(r0, 0, line);
    }
    this.revision++;
    return true;
  }

  /** Remove a whole line, always leaving at least one line. */
  cutLine(row: number): string {
    this.revision++;
    if (this.lines.length === 1) {
      const line = this.lines[0];
      this.lines[0] = "";
      return line;
    }
    return this.lines.splice(row, 1)[0];
  }

  /** Insert whole lines above `row`. */
  pasteLines(row: number, lines: string[]): void {
    this.lines.splice(row, 0, ...lines);
    this.revision++;
  }
}

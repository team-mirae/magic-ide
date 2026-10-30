// One open file: its buffer, undo history, cursor and view position.
// The editor shows one Doc at a time; switching tabs swaps Docs.

import type { Highlighter, Token } from "../plugins/api";
import { Buffer, type Pos } from "./buffer";
import { History } from "./history";

export class Doc {
  buf: Buffer;
  history = new History();
  cy = 0;
  cx = 0;
  /** Display column the cursor tries to stay in when moving vertically. */
  wantCol = 0;
  /** Other end of the selection; the cursor is always one end. */
  anchor: Pos | null = null;
  rowOff = 0;
  colOff = 0;
  /** Content state now and at the last save; they differ when modified. */
  state = 0;
  savedState = 0;

  // Highlighting cache: the line each entry was computed for, its tokens,
  // and the tokenizer state at the start of the next line.
  hlLines: string[] = [];
  hlTokens: Token[][] = [];
  hlStates: unknown[] = [];
  hlRevision = -1;

  constructor(
    public path: string,
    content: string,
    public highlighter: Highlighter<any>,
  ) {
    this.buf = new Buffer(content);
  }

  get dirty(): boolean {
    return this.state !== this.savedState;
  }

  setHighlighter(h: Highlighter<any>): void {
    this.highlighter = h;
    this.hlLines = [];
    this.hlTokens = [];
    this.hlStates = [];
    this.hlRevision = -1;
  }

  /** Tokens for rows up to `upTo`, re-tokenizing from the first line that changed. */
  tokens(upTo: number): Token[][] {
    const lines = this.buf.lines;
    if (this.hlRevision !== this.buf.revision) {
      let i = 0;
      const n = Math.min(this.hlLines.length, lines.length);
      while (i < n && this.hlLines[i] === lines[i]) i++;
      this.hlLines.length = i;
      this.hlTokens.length = i;
      this.hlStates.length = i;
      this.hlRevision = this.buf.revision;
    }
    const end = Math.min(upTo, lines.length - 1);
    for (let i = this.hlLines.length; i <= end; i++) {
      const state = i === 0 ? this.highlighter.startState() : this.hlStates[i - 1];
      let tokens: Token[] = [];
      let next = state;
      try {
        const r = this.highlighter.tokenizeLine(lines[i], state);
        tokens = r.tokens;
        next = r.state;
      } catch (err) {
        // A broken plugin degrades to plain text rather than breaking the editor.
        console.error(`highlighter ${this.highlighter.id} failed`, err);
      }
      this.hlLines.push(lines[i]);
      this.hlTokens.push(tokens);
      this.hlStates.push(next);
    }
    return this.hlTokens;
  }
}

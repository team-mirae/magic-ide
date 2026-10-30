// Undo and redo, ported from zencode's history.rs. Each step keeps a full
// copy of the lines from before an edit. Consecutive edits of the same kind
// at the spot where the last one left the cursor share a step, so a typed
// run of text undoes at once, like an insert-mode run in vim. Any other
// edit, or moving the cursor, starts a new step.

import type { Pos } from "./buffer";
import { posEq } from "./buffer";

const MAX_STEPS = 1000;

export enum EditKind {
  Type,
  Backspace,
  Delete,
  MoveLines,
  /** Never merged with anything: Enter, paste, extract, and so on. */
  Other,
}

/** Buffer contents plus where the cursor and selection were. */
export interface Snapshot {
  lines: string[];
  cursor: Pos;
  anchor: Pos | null;
  /** Identifies the content, so undoing back to the saved state counts as unmodified. */
  state: number;
}

export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Kind of the last edit and where it left the cursor. */
  private last: { kind: EditKind; at: Pos } | null = null;

  /** Whether an edit of `kind` with the cursor at `at` joins the current step. */
  continues(kind: EditKind, at: Pos): boolean {
    return kind !== EditKind.Other && this.last !== null && this.last.kind === kind && posEq(this.last.at, at);
  }

  /** Record a finished edit. `before` is null when the edit joined the current step. */
  record(before: Snapshot | null, kind: EditKind, after: Pos): void {
    if (before) {
      if (this.undoStack.length === MAX_STEPS) this.undoStack.shift();
      this.undoStack.push(before);
    }
    this.redoStack = [];
    this.last = { kind, at: after };
  }

  /** End the current step so the next edit starts a new one. */
  breakStep(): void {
    this.last = null;
  }

  /** Swap `current` for the previous state, if there is one. */
  undo(current: Snapshot): Snapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(current);
    this.last = null;
    return prev;
  }

  /** Swap `current` for the next state, if there is one. */
  redo(current: Snapshot): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current);
    this.last = null;
    return next;
  }
}

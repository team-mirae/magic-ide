// magic-ide plugin API, version 1.
//
// A plugin module is an ES module, loaded by URL, whose default export is
// a `PluginModule`. A module can contribute any mix of syntax
// highlighters, code runners and file viewers. The full contract, with examples, is in
// docs/PLUGINS.md; this file is the source of truth for the types.
//
// Plugins only depend on these types, never on magic-ide internals, so a
// plugin can be written without importing anything. The same types are
// published at /plugin-api.d.ts on every deployment.

export const PLUGIN_API_VERSION = 1;

// ----- syntax highlighting ---------------------------------------------------

/**
 * Token scopes. The theme colors the first dot-separated segment, so
 * plugins may be more specific ("string.escape", "keyword.control") and
 * still get a sensible color. Unknown scopes are drawn as plain text.
 */
export type Scope =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "constant"
  | "function"
  | "type"
  | "variable"
  | "property"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "regexp"
  | "invalid"
  | (string & {});

export interface Token {
  /** UTF-16 offset of the first character in the line. */
  start: number;
  /** UTF-16 offset just past the last character. */
  end: number;
  scope: Scope;
}

export interface LineResult<S> {
  /** Tokens in order, non-overlapping. Gaps are plain text. */
  tokens: Token[];
  /** State at the start of the next line. */
  state: S;
}

/**
 * A line-by-line tokenizer. The editor calls `tokenizeLine` for each line
 * in order, feeding the state returned for one line into the next, and
 * caches results so only edited lines and the ones after them are redone.
 * `tokenizeLine` must be pure: same line and state in, same result out,
 * without mutating `state`.
 */
export interface Highlighter<S = unknown> {
  /** Unique id, e.g. "rust". Loading a second highlighter with the same id replaces the first. */
  id: string;
  /** Shown in the status bar, e.g. "Rust". */
  name: string;
  /** File extensions, lowercase with the dot: [".rs"]. */
  extensions?: string[];
  /** Exact file names: ["Makefile", "Dockerfile"]. Checked before extensions. */
  filenames?: string[];
  /** State before the first line. */
  startState(): S;
  tokenizeLine(line: string, state: S): LineResult<S>;
}

// ----- code execution --------------------------------------------------------

/** Workspace access granted to a runner. Paths are absolute ("/src/main.py"). */
export interface RunnerFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  stat(path: string): Promise<{ type: "file" | "dir"; size: number; mtime: number } | null>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RunRequest {
  /** Absolute path of the file being run. */
  entry: string;
  /** Contents of `entry`, already read for convenience. */
  source: string;
  /** Arguments after the file name: `run main.py a b` → ["a", "b"]. */
  args: string[];
  /** The terminal's working directory. */
  cwd: string;
  env: Record<string, string>;
  fs: RunnerFs;
}

export interface RunIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Read one line typed into the terminal, without the newline. null at end of input (⌃D). */
  readLine(prompt?: string): Promise<string | null>;
  /** Aborted when the user presses ⌃C. The runner should stop promptly and resolve. */
  signal: AbortSignal;
}

export interface Runner {
  /** Unique id, e.g. "python". */
  id: string;
  name: string;
  /** File extensions this runner executes, lowercase with the dot: [".py"]. */
  extensions: string[];
  /**
   * Optional one-time setup before the first run, such as fetching a
   * WASM toolchain. Called at most once per page load; progress can be
   * written to `log`.
   */
  prepare?(log: (text: string) => void): Promise<void>;
  /** Run a program and resolve with its exit code. */
  run(req: RunRequest, io: RunIO): Promise<number>;
}

// ----- file viewers & editors ------------------------------------------------

/**
 * A viewer (or editor) for a kind of file, shown in place of zencode in
 * the file's tab: an image preview, a hex view, a CSV grid, a markdown
 * renderer. With `default: true` it opens automatically for its files;
 * otherwise it is offered under "Open With…", next to zencode.
 */
export interface Viewer {
  /** Unique id, e.g. "image-preview". */
  id: string;
  /** Shown in "Open With…" and the status bar. */
  name: string;
  /** File extensions, lowercase with the dot: [".png", ".jpg"]. */
  extensions?: string[];
  /** Exact file names: ["Dockerfile"]. */
  filenames?: string[];
  /** Open matching files with this viewer instead of zencode. */
  default?: boolean;
  /** Whether `read` and `write` deal in UTF-8 text or raw bytes. */
  encoding: "text" | "binary";
  /**
   * Render into `el`, which the viewer owns until `dispose`. `el` is
   * sized by the app; use the CSS variables --bg, --fg, --accent and
   * --font-mono to match the theme.
   */
  mount(el: HTMLElement, ctx: ViewerContext): ViewerInstance | Promise<ViewerInstance>;
}

export interface ViewerContext {
  /** Absolute workspace path of the file. */
  path: string;
  /** The file's contents, as text or bytes per the viewer's `encoding`. */
  read(): Promise<string | Uint8Array>;
  /** Write new contents. Viewers that only view never call it. */
  write(data: string | Uint8Array): Promise<void>;
  /** Mark the tab modified, so closing it asks first. Call with false after saving. */
  setDirty(dirty: boolean): void;
  /** A short message in the status bar. */
  setStatus(text: string): void;
  /** MIME type guessed from the extension, e.g. "image/png", or "" when unknown. */
  mime: string;
}

export interface ViewerInstance {
  /** ⌃S in the tab. Write via `ctx.write`, then `ctx.setDirty(false)`. */
  save?(): Promise<void>;
  /** The file changed on disk (e.g. from the terminal); re-read if needed. */
  reload?(): void;
  focus?(): void;
  /** Remove listeners and free resources (object URLs, workers). */
  dispose(): void;
}

// ----- module ----------------------------------------------------------------

export interface PluginModule {
  /** Must equal PLUGIN_API_VERSION. */
  api: 1;
  /** Unique id for the module itself, e.g. "acme-rust". */
  id: string;
  name: string;
  version?: string;
  highlighters?: Highlighter<any>[];
  runners?: Runner[];
  viewers?: Viewer[];
}

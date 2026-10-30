# Plugins

magic-ide ships with almost nothing built in: plain text, a JavaScript
runner, and the zencode editor. Everything else (syntax highlighting,
running other languages, previewing images) comes from **plugin
modules** that users install by URL.

- Install: **⋯ → Plugins…**, or `plugin add <url>` in the terminal.
- Remove: the same dialog, or `plugin rm <id>`.
- List: `plugin`, `runners`.

Installed modules load again on every start, and the service worker
caches them, so they keep working offline.

> A plugin runs with full access to the page and the user's workspaces.
> Only install code you trust.

## The module

A plugin is a single ES module whose default export is a `PluginModule`.
It can contribute any mix of **highlighters**, **runners** and
**viewers**:

```js
export default {
  api: 1,               // must be 1
  id: "acme-rust",      // unique
  name: "Rust for magic-ide",
  version: "1.0.0",
  highlighters: [/* Highlighter */],
  runners: [/* Runner */],
  viewers: [/* Viewer */],
};
```

The types are the contract. They live in
[`src/plugins/api.ts`](../src/plugins/api.ts) and every deployment serves
them at [`/plugin-api.d.ts`](https://magic-ide.sjun.me/plugin-api.d.ts):

```ts
/// <reference path="./plugin-api.d.ts" />
import type { PluginModule } from "./plugin-api";
```

Plugins never import magic-ide internals, so the module can be hosted
anywhere that serves JavaScript with CORS (a CDN such as jsDelivr or
esm.sh works). Its own imports must be absolute URLs or relative to the
module.

Later modules win: a plugin can replace a built-in, and if two modules
share an `id`, the one installed last replaces the other.

## Highlighters

A highlighter is a line-by-line tokenizer with explicit state, so the
editor can cache results and only re-tokenize from the first edited line.

```ts
interface Highlighter<S> {
  id: string;
  name: string;               // shown in the status bar
  extensions?: string[];      // [".rs"], lowercase with the dot
  filenames?: string[];       // ["Makefile"], checked before extensions
  startState(): S;
  tokenizeLine(line: string, state: S): { tokens: Token[]; state: S };
}

interface Token {
  start: number;              // UTF-16 offsets within the line
  end: number;
  scope: Scope;
}
```

Rules:

- `tokenizeLine` must be **pure**: the same line and state give the same
  result, and `state` must not be mutated (return a new one).
- Tokens are in order and don't overlap. Gaps are plain text.
- If `tokenizeLine` throws, that line is drawn as plain text.

**Scopes** are `keyword`, `string`, `comment`, `number`, `constant`,
`function`, `type`, `variable`, `property`, `operator`, `punctuation`,
`tag`, `attribute`, `regexp` and `invalid`. A scope may be more specific
(`string.escape`, `keyword.control`); the theme colors the first segment.

Example, a highlighter for `#` comments and quoted strings, with block
comments carried across lines in the state:

```js
const conf = {
  id: "conf",
  name: "Config",
  extensions: [".conf", ".ini"],
  startState: () => ({ inBlock: false }),
  tokenizeLine(line, state) {
    const tokens = [];
    let inBlock = state.inBlock;
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        const stop = end < 0 ? line.length : end + 2;
        tokens.push({ start: i, end: stop, scope: "comment" });
        inBlock = end < 0;
        i = stop;
      } else if (line.startsWith("/*", i)) {
        inBlock = true;
      } else if (line[i] === "#") {
        tokens.push({ start: i, end: line.length, scope: "comment" });
        break;
      } else if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        const stop = end < 0 ? line.length : end + 1;
        tokens.push({ start: i, end: stop, scope: "string" });
        i = stop;
      } else {
        i++;
      }
    }
    return { tokens, state: { inBlock } };
  },
};

export default { api: 1, id: "conf", name: "Config files", highlighters: [conf] };
```

## Runners

A runner executes a file when the user types `run <file>` (or `./file`,
or a bare file name) in the terminal, or picks **Run in Terminal** in the
explorer. It is chosen by the file's extension.

```ts
interface Runner {
  id: string;
  name: string;
  extensions: string[];                       // [".py"]
  prepare?(log: (text: string) => void): Promise<void>;
  run(req: RunRequest, io: RunIO): Promise<number>;   // exit code
}

interface RunRequest {
  entry: string;            // "/src/main.py"
  source: string;           // its contents
  args: string[];           // `run main.py a b` → ["a", "b"]
  cwd: string;
  env: Record<string, string>;
  fs: RunnerFs;             // readFile, writeFile, readdir, stat, mkdir, remove
}

interface RunIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readLine(prompt?: string): Promise<string | null>;  // null on ⌃D
  signal: AbortSignal;                                // aborted by ⌃C
}
```

Rules:

- `prepare` runs at most once per page load, before the first `run`. Use
  it to download a toolchain (a WASM interpreter, a compiler); write
  progress to `log`. If it rejects, it is retried on the next run.
- Resolve `run` with the exit code. Non-zero codes are shown as
  `[exit N]`.
- When `io.signal` aborts, stop promptly and resolve (130 is
  conventional). Output written after abort is dropped.
- Paths given to `fs` may be relative to `cwd`. Writes show up in the
  explorer right away.
- Output may contain ANSI SGR colors (`\x1b[31m`); other escapes are
  ignored.
- Run untrusted user code off the main thread (a Worker or an iframe), so
  a busy loop can't freeze the IDE.

The built-in [JavaScript runner](../src/plugins/builtin/javascript.ts) is
the reference implementation: it runs the file in a throwaway Worker and
terminates it on ⌃C.

## Viewers

A viewer shows (or edits) a kind of file in a tab instead of zencode: an
image preview, a hex view, a CSV grid, a Markdown preview.

```ts
interface Viewer {
  id: string;
  name: string;               // "Open With <name>"
  extensions?: string[];
  filenames?: string[];
  default?: boolean;          // open matching files with this viewer
  encoding: "text" | "binary";
  mount(el: HTMLElement, ctx: ViewerContext): ViewerInstance | Promise<ViewerInstance>;
}

interface ViewerContext {
  path: string;
  mime: string;               // guessed from the extension, or ""
  read(): Promise<string | Uint8Array>;      // per `encoding`
  write(data: string | Uint8Array): Promise<void>;
  setDirty(dirty: boolean): void;            // tab shows ●, close asks first
  setStatus(text: string): void;
}

interface ViewerInstance {
  save?(): Promise<void>;     // ⌃S / ⌘S in the tab
  reload?(): void;
  focus?(): void;
  dispose(): void;            // free object URLs, workers, listeners
}
```

Rules:

- With `default: true` the viewer opens its files automatically; the
  explorer's **Open in zencode** is always available too. Without it, the
  viewer is offered under **Open With …**.
- Binary files with no viewer can't be opened in zencode; the user is
  told to install one.
- `el` is sized by the app and scrolls. Match the theme with the CSS
  variables `--bg`, `--fg`, `--panel`, `--line`, `--pink`, `--violet`,
  `--accent` (the gradient) and `--font-mono`.
- Long press and right click on `el` open the app's context menu; the
  browser's own menu is always suppressed.

Example, an image preview:

```js
const image = {
  id: "image-preview",
  name: "Image Preview",
  extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"],
  default: true,
  encoding: "binary",
  async mount(el, ctx) {
    const url = URL.createObjectURL(new Blob([await ctx.read()], { type: ctx.mime }));
    el.innerHTML = `<div style="display:grid;place-items:center;min-height:100%;padding:16px">
      <img style="max-width:100%;image-rendering:auto" alt=""></div>`;
    const img = el.querySelector("img");
    img.src = url;
    img.onload = () => ctx.setStatus(`${img.naturalWidth} × ${img.naturalHeight}`);
    return { dispose: () => URL.revokeObjectURL(url) };
  },
};

export default { api: 1, id: "image-preview", name: "Image Preview", viewers: [image] };
```

Users add images to a workspace with **Upload Files…** or by dropping
them on the explorer.

## Versioning

`api` is the contract version. Additive changes (new optional fields,
new scopes) keep `api: 1`. A breaking change bumps it, and magic-ide
refuses modules built for a version it doesn't support, with a message
saying so.

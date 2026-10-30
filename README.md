# magic-ide

An IDE that works like magic. Open [magic-ide.sjun.me](https://magic-ide.sjun.me),
and it installs itself into the browser: it keeps working offline, and
can be installed as an app.

- **Explorer**: files and folders, upload, download as .zip.
- **Editor**: [zencode](https://github.com/team-mirae/zencode) (젠코드 · ゼンコード),
  with its keys and its 全角-aware grid, ported to the browser.
- **VENV terminal**: a small shell over the workspace (`ls`, `cd`, `cat`,
  `mv`, `run`, …). There is no host filesystem in a browser, so the
  terminal works on the workspace's virtual one.
- **Plugins**: syntax highlighting, code execution and file viewers are
  plug and play. See [docs/PLUGINS.md](docs/PLUGINS.md).

The public site stores workspaces in your browser. Self-hosted, magic-ide
can host workspaces on its server instead: see
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Input, on every device

- Right click, ⌃-click (macOS) and long press all open the same menus.
  They are square and translucent, unlike any native menu, so a native
  one showing up means something broke.
- ⇧+click extends a selection the same way on every OS. On touch, a
  one-finger drag works like ⇧+drag and two fingers scroll.
- Typing goes through a layer built for IMEs: Korean 2-set (KTS),
  Samsung's US/Korean hybrid, Gboard, and JIS romaji-English hybrid
  keyboards that keep English staged until commit. `tests/` has a robot
  for each.
- Phones get an on-screen key bar (Esc, Tab, sticky ⌃ ⌥ ⇧, arrows), plus
  ⌃C / ⌃D / ⌃L in the terminal.

## Keys

zencode's keys, with three browser changes: ⌃X closes the tab, ⌃O
exports inside the workspace, and ⌘S also saves. ⌃/ or F1 shows them
all; [KEYBINDS.md](https://github.com/team-mirae/zencode/blob/main/KEYBINDS.md)
explains why they are what they are.

## Develop

```sh
npm ci
npm run dev        # http://localhost:5173
npm test           # IME robots and friends
npm run build
```

Plain TypeScript and the DOM, no framework. `src/zencode/` is the editor
port, `src/ui/` the rest of the interface, `src/fs/` workspaces,
`src/plugins/` the plugin API.

Pushes to `main` deploy to Vercel through GitHub Actions.

## License

MIT © Mirae Research

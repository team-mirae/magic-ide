# Self-hosting

The public build at [magic-ide.sjun.me](https://magic-ide.sjun.me) keeps
every workspace in the visitor's browser. A self-hosted magic-ide can
**host workspaces** instead: files live on the server's disk, so they
follow you between devices and can be backed up like any directory.

The same build does both. On start the app asks `GET /api/config`; if it
answers `{ "workspaces": true }`, workspaces come from the server, and the
header shows **server** instead of **browser**.

## Run it

Needs Node.js 22 or newer. No other dependencies at runtime.

```sh
git clone https://github.com/team-mirae/magic-ide
cd magic-ide
npm ci
npm run build
npm run serve
```

Then open <http://127.0.0.1:8080>.

| Variable             | Default            | Meaning                                    |
|----------------------|--------------------|--------------------------------------------|
| `PORT`               | `8080`             | Port to listen on                          |
| `HOST`               | `127.0.0.1`        | Interface; `0.0.0.0` to listen on all      |
| `MAGIC_IDE_DATA`     | `./data`           | Where workspaces are stored                |
| `MAGIC_IDE_USER`     |                    | With the password, turns on Basic auth     |
| `MAGIC_IDE_PASSWORD` |                    |                                            |

Each workspace is a directory `MAGIC_IDE_DATA/<id>/`, listed in
`MAGIC_IDE_DATA/workspaces.json`.

## Security

Anyone who can reach the server can read and write every hosted
workspace. Before listening beyond localhost:

- set `MAGIC_IDE_USER` and `MAGIC_IDE_PASSWORD`, and
- put it behind HTTPS (a reverse proxy such as Caddy or nginx). Service
  workers, and so offline use and installing the app, need HTTPS anywhere
  but localhost.

The server refuses paths that escape a workspace, through `..` or
symlinks. Code still only runs in the browser: runners execute in the
visitor's browser, never on the server.

## API

All paths are absolute workspace paths (`/src/main.rs`). Errors are
`{ "code": "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "EINVAL" | "EIO", "message": "…" }`
with a 4xx or 5xx status.

| Method   | Path                                           | Body / result                         |
|----------|------------------------------------------------|---------------------------------------|
| `GET`    | `/api/config`                                  | `{ "workspaces": true }`              |
| `GET`    | `/api/workspaces`                              | `[{ id, name }]`                      |
| `POST`   | `/api/workspaces`                              | `{ name }` → `{ id, name }`           |
| `DELETE` | `/api/workspaces/:id`                          |                                       |
| `GET`    | `/api/workspaces/:id/fs?path=…&op=read`        | file as UTF-8 text                    |
| `GET`    | `/api/workspaces/:id/fs?path=…&op=bytes`       | file as raw bytes                     |
| `GET`    | `/api/workspaces/:id/fs?path=…&op=list`        | `[{ name, type: "file" \| "dir" }]`   |
| `GET`    | `/api/workspaces/:id/fs?path=…&op=stat`        | `{ type, size, mtime }` or `null`     |
| `PUT`    | `/api/workspaces/:id/fs?path=…`                | raw contents; creates parents         |
| `POST`   | `/api/workspaces/:id/fs?path=…&op=mkdir`       | creates parents                       |
| `POST`   | `/api/workspaces/:id/fs?path=…&op=rename`      | `{ to }`                              |
| `DELETE` | `/api/workspaces/:id/fs?path=…`                | removes recursively                   |

Any server implementing this API can host workspaces for magic-ide; the
bundled `server/index.js` is one implementation.

// POSIX path helpers for workspace paths.

/** Resolve `p` against `cwd` into a normalized absolute path. */
export function resolve(cwd: string, p: string): string {
  const parts = (p.startsWith("/") ? p : `${cwd}/${p}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** ".rs" for "/src/main.rs", "" when there is none. Dotfiles have no extension. */
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

export function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Whether `p` is `dir` itself or inside it. */
export function within(p: string, dir: string): boolean {
  return dir === "/" || p === dir || p.startsWith(dir + "/");
}

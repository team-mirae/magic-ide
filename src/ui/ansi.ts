// Just enough ANSI for program output: SGR colors and bold. Every other
// escape sequence is dropped.

export interface Styled {
  text: string;
  cls: string;
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

export class AnsiParser {
  private fg = "";
  private bold = false;
  private pending = "";

  /** Split a chunk into styled runs. Escapes cut across chunks are held until complete. */
  parse(chunk: string): Styled[] {
    const s = this.pending + chunk;
    this.pending = "";
    const out: Styled[] = [];
    const re = /\x1b(?:\[([0-9;?]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
    let last = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
      if (m.index > last) out.push({ text: s.slice(last, m.index), cls: this.cls() });
      last = re.lastIndex;
      if (m[2] === "m") this.sgr(m[1]);
    }
    let rest = s.slice(last);
    const esc = rest.lastIndexOf("\x1b");
    if (esc >= 0 && rest.length - esc < 32) {
      this.pending = rest.slice(esc);
      rest = rest.slice(0, esc);
    }
    if (rest) out.push({ text: rest, cls: this.cls() });
    return out;
  }

  private sgr(params: string): void {
    const codes = params === "" ? [0] : params.split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        this.fg = "";
        this.bold = false;
      } else if (c === 1) this.bold = true;
      else if (c === 22) this.bold = false;
      else if (c >= 30 && c <= 37) this.fg = NAMES[c - 30];
      else if (c >= 90 && c <= 97) this.fg = "bright-" + NAMES[c - 90];
      else if (c === 39) this.fg = "";
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }

  private cls(): string {
    return [this.fg && `a-${this.fg}`, this.bold && "a-bold"].filter(Boolean).join(" ");
  }
}

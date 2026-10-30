// Runs JavaScript in a throwaway Web Worker, so a busy loop can't freeze
// the editor and ⌃C can always stop it. console.* goes to the terminal,
// and `argv` holds the arguments. Also the reference Runner implementation.

import type { Runner } from "../api";

const PRELUDE = `
const send = (stream, args) => postMessage({ stream, text: args.map(fmt).join(" ") + "\\n" });
const fmt = (v) => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
};
console.log = console.info = console.debug = (...a) => send("stdout", a);
console.error = console.warn = (...a) => send("stderr", a);
self.onmessage = async (e) => {
  const { source, argv } = e.data;
  try {
    const fn = new (async function () {}).constructor("argv", source);
    await fn(argv);
    postMessage({ exit: 0 });
  } catch (err) {
    send("stderr", [err]);
    postMessage({ exit: 1 });
  }
};
`;

export const javascriptRunner: Runner = {
  id: "javascript",
  name: "JavaScript (Web Worker)",
  extensions: [".js", ".mjs"],
  run(req, io) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([PRELUDE], { type: "text/javascript" }));
      const worker = new Worker(url);
      const finish = (code: number) => {
        worker.terminate();
        URL.revokeObjectURL(url);
        io.signal.removeEventListener("abort", onAbort);
        resolve(code);
      };
      const onAbort = () => finish(130);
      io.signal.addEventListener("abort", onAbort);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.stream === "stdout") io.stdout(m.text);
        else if (m.stream === "stderr") io.stderr(m.text);
        else if ("exit" in m) finish(m.exit);
      };
      worker.onerror = (e) => {
        io.stderr(`${e.message}\n`);
        finish(1);
      };
      worker.postMessage({ source: req.source, argv: req.args });
    });
  },
};

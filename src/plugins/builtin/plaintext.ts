// The fallback highlighter: no tokens at all. Also the smallest example of
// the Highlighter contract.

import type { Highlighter } from "../api";

export const plaintext: Highlighter<null> = {
  id: "plaintext",
  name: "Plain Text",
  extensions: [".txt"],
  startState: () => null,
  tokenizeLine: () => ({ tokens: [], state: null }),
};

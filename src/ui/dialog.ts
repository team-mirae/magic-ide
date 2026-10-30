// Small modal dialogs, styled like the context menus. window.prompt is
// avoided: it looks different on every OS and is blocked in some
// installed-app contexts.

function modal(build: (box: HTMLElement, close: () => void) => HTMLElement | null): () => void {
  const restore = document.activeElement as HTMLElement | null;
  const shade = document.createElement("div");
  shade.className = "dialog-shade";
  const box = document.createElement("div");
  box.className = "dialog";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  shade.appendChild(box);
  const close = () => {
    shade.remove();
    restore?.focus({ preventScroll: true });
  };
  const first = build(box, close);
  shade.addEventListener("pointerdown", (e) => {
    if (e.target === shade) {
      e.preventDefault();
      box.dispatchEvent(new CustomEvent("cancel"));
    }
  });
  document.body.appendChild(shade);
  (first ?? box.querySelector("button"))?.focus();
  return close;
}

function buttons(box: HTMLElement, ok: string, danger: boolean): { okBtn: HTMLButtonElement; cancelBtn: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "dialog-buttons";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.type = "submit";
  okBtn.textContent = ok;
  okBtn.className = danger ? "danger" : "primary";
  row.append(cancelBtn, okBtn);
  box.appendChild(row);
  return { okBtn, cancelBtn };
}

/** Ask for a line of text. Resolves null when cancelled. */
export function ask(title: string, initial = "", ok = "OK", selectStem = false): Promise<string | null> {
  return new Promise((resolve) => {
    modal((box, close) => {
      const form = document.createElement("form");
      form.innerHTML = `<label class="dialog-title"></label><input class="dialog-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">`;
      form.querySelector("label")!.textContent = title;
      const input = form.querySelector("input")!;
      input.value = initial;
      box.appendChild(form);
      const { cancelBtn } = buttons(form, ok, false);
      const done = (v: string | null) => {
        close();
        resolve(v);
      };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = input.value.trim();
        done(v ? v : null);
      });
      cancelBtn.addEventListener("click", () => done(null));
      box.addEventListener("cancel", () => done(null));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.isComposing) done(null);
      });
      queueMicrotask(() => {
        // Select the name without its extension, like a file manager does.
        const dot = initial.lastIndexOf(".");
        input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
      });
      return input;
    });
  });
}

/** Ask a yes / no question. */
export function confirm(message: string, ok = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    modal((box, close) => {
      const form = document.createElement("form");
      const p = document.createElement("p");
      p.className = "dialog-title";
      p.textContent = message;
      form.appendChild(p);
      box.appendChild(form);
      const { okBtn, cancelBtn } = buttons(form, ok, danger);
      const done = (v: boolean) => {
        close();
        resolve(v);
      };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        done(true);
      });
      cancelBtn.addEventListener("click", () => done(false));
      box.addEventListener("cancel", () => done(false));
      form.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done(false);
      });
      return danger ? cancelBtn : okBtn;
    });
  });
}

/** A dialog with arbitrary content and a Close button. */
export function panel(title: string, body: HTMLElement): () => void {
  return modal((box, close) => {
    const h = document.createElement("div");
    h.className = "dialog-title";
    h.textContent = title;
    box.append(h, body);
    const row = document.createElement("div");
    row.className = "dialog-buttons";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Close";
    b.addEventListener("click", close);
    row.appendChild(b);
    box.appendChild(row);
    box.addEventListener("cancel", close);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    return null;
  });
}

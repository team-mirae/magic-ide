// Context menus, the same on every OS and input device.
//
// The browser's own context menu is suppressed everywhere in the app; a
// right click, ⌃-click on macOS, or a long press on a touch screen all
// open our menu instead. Our menus are square and translucent on purpose,
// so if a native menu ever shows up it is obviously a bug, not something
// to click.
//
// A long press also swallows the click that follows it, so lifting the
// finger never activates whatever was under it.

export type MenuItem =
  | { label: string; hint?: string; action: () => void; disabled?: boolean; danger?: boolean }
  | "separator";

export type MenuSource = (target: HTMLElement, x: number, y: number) => MenuItem[] | null;

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

const sources = new WeakMap<HTMLElement, MenuSource>();

/** Give `el` (and its descendants without a closer source) a context menu. */
export function contextMenu(el: HTMLElement, source: MenuSource): void {
  sources.set(el, source);
}

let open: { el: HTMLElement; close: () => void } | null = null;

/** Pointer capture, which throws for pointers the browser already dropped. */
export function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // The drag still works without capture while the pointer stays over `el`.
  }
}

export function closeMenu(): void {
  open?.close();
}

export function isMenuOpen(): boolean {
  return open !== null;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const restore = document.activeElement as HTMLElement | null;
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  el.tabIndex = -1;
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === "separator") {
      el.appendChild(Object.assign(document.createElement("div"), { className: "menu-sep" }));
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item" + (item.danger ? " danger" : "");
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    b.innerHTML = `<span></span><kbd></kbd>`;
    b.firstElementChild!.textContent = item.label;
    b.lastElementChild!.textContent = item.hint ?? "";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      close(false);
      item.action();
    });
    b.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") b.focus({ preventScroll: true });
    });
    el.appendChild(b);
    buttons.push(b);
  }
  document.body.appendChild(el);

  // Keep it on screen, flipping left / up when it would overflow.
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.left = `${Math.max(4, x + r.width > vw - 4 ? x - r.width : x)}px`;
  el.style.top = `${Math.max(4, y + r.height > vh - 4 ? y - r.height : y)}px`;

  const enabled = () => buttons.filter((b) => !b.disabled);
  const onKey = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") close(true);
    else if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[(i < 0 ? list.length : i) - 1]?.focus();
    else if (e.key === "Enter" && i < 0) return;
    else if (e.key === "Tab") close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onOutside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) close(true);
  };
  const onBlur = () => close(false);

  function close(refocus: boolean) {
    if (open?.el !== el) return;
    open = null;
    el.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onBlur);
    if (refocus) restore?.focus({ preventScroll: true });
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onBlur);
  open = { el, close: () => close(false) };
  // The menu itself takes focus, so nothing looks preselected; ↑↓ move into it.
  el.focus({ preventScroll: true });
}

function dispatch(target: EventTarget | null, x: number, y: number): boolean {
  for (let n = target instanceof HTMLElement ? target : null; n; n = n.parentElement) {
    const source = sources.get(n);
    if (!source) continue;
    const items = source(target as HTMLElement, x, y);
    if (items?.length) {
      showMenu(x, y, items);
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Listeners for the whole document. Call once at startup.
 *
 * Touch devices are handled by our own long-press timer rather than the
 * native `contextmenu` event, because Android fires one on long press and
 * iOS Safari never does; this way both behave the same.
 */
export function installGlobalMenus(): void {
  let lastTouch = 0;
  let press: { id: number; x: number; y: number; timer: number; target: EventTarget | null } | null = null;
  let swallowClick = false;

  document.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      if (performance.now() - lastTouch < 1000) return;
      dispatch(e.target, e.clientX, e.clientY);
    },
    true,
  );

  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      lastTouch = performance.now();
      cancel();
      if (!e.isPrimary) return;
      const p = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        target: e.target,
        timer: window.setTimeout(() => {
          press = null;
          lastTouch = performance.now();
          if (dispatch(p.target, p.x, p.y)) {
            swallowClick = true;
            // Let the element under the finger drop any drag it started.
            p.target?.dispatchEvent(new CustomEvent("longpress", { bubbles: true }));
            navigator.vibrate?.(10);
          }
        }, LONG_PRESS_MS),
      };
      press = p;
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) {
        cancel();
      }
    },
    true,
  );
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "mouse") lastTouch = performance.now();
    cancel();
  }, true);
  document.addEventListener("pointercancel", cancel, true);
  // A second finger means a scroll or pinch, not a press.
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length > 1) cancel();
  }, { capture: true, passive: true });
  document.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  document.addEventListener("pointerdown", () => {
    swallowClick = false;
  });
}

import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";

// Offline: the service worker precaches the whole app and updates itself
// in the background; the new version is used on the next load.
registerSW({ immediate: true });

// Remember the install prompt so the menu can offer "Install App".
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  (window as Window & { __installPrompt?: Event }).__installPrompt = e;
});

// Keep the layout above the soft keyboard on iOS, which doesn't resize
// the layout viewport when the keyboard opens.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
    window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

const app = new App(document.getElementById("app")!);
// For poking at the app from devtools while developing.
if (import.meta.env.DEV) (window as Window & { magicIde?: App }).magicIde = app;
app.start().catch((e) => {
  console.error(e);
  document.getElementById("app")!.insertAdjacentHTML(
    "beforeend",
    `<div class="fatal">magic-ide couldn't start: ${String((e as Error).message ?? e).replace(/</g, "&lt;")}</div>`,
  );
});

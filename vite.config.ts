import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Publish the plugin API types at /plugin-api.d.ts for plugin authors. */
function pluginApiTypes(): Plugin {
  const dts = () =>
    readFileSync("src/plugins/api.ts", "utf8").replace("export const PLUGIN_API_VERSION = 1;", "export declare const PLUGIN_API_VERSION = 1;");
  return {
    name: "plugin-api-types",
    configureServer(server) {
      server.middlewares.use("/plugin-api.d.ts", (_req, res) => {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(dts());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "plugin-api.d.ts", source: dts() });
    },
  };
}

export default defineConfig({
  plugins: [
    pluginApiTypes(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "magic-ide",
        short_name: "magic-ide",
        description: "An IDE that works like magic. Offline-first, with the zencode editor.",
        theme_color: "#181622",
        background_color: "#181622",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ts,webmanifest}"],
        navigateFallback: "/index.html",
        // A self-hosted server's API must never be answered from the cache.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Plugin modules from other origins: cached so installed plugins load offline.
            urlPattern: ({ request, url }) => request.destination === "script" && url.origin !== self.location.origin,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "magic-ide-plugins", expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Expose the release version to the app so the badge cannot drift from the
// package manifest.
//
// `./VERSION` is checked before `../VERSION` deliberately. Both layouts exist:
// the maintenance tree keeps VERSION one level above client/, while a release
// bundle is often unpacked with the client files at the root, where `../VERSION`
// points outside the bundle and can resolve to a stale unrelated file. Reading the
// closer, more specific file first avoids silently injecting the wrong version —
// which happened during 1.17.7 packaging and produced a build labelled 1.17.6.
function resolveVersion() {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  for (const candidate of ["./VERSION", "../VERSION"]) {
    try {
      const value = readFileSync(new URL(candidate, import.meta.url), "utf8").trim();
      if (value) return value;
    } catch { /* fall through to the next candidate, then the manifest */ }
  }
  return pkg.version || "0.0.0";
}

export default defineConfig({
  plugins: [react()],
  // This workspace can live on a mapped network drive, where esbuild's
  // realpath returns the UNC form and vite's dep optimizer then mis-joins it
  // into an unreadable "W:\<host>\..." path. Skipping realpath resolution
  // keeps every path on the drive letter; the project has no symlinked
  // dependencies, so ordinary resolution is unaffected.
  resolve: {
    preserveSymlinks: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/covers": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("hls.js")) return "hls";
          if (id.includes("flv.js")) return "flv";
          return undefined;
        },
      },
    },
  },
});

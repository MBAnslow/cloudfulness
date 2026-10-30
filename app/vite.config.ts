import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(import.meta.dirname, "..")],
    },
    watch: {
      // The default config is read when the page loads. Autosave may
      // rewrite it; that should not refresh the running app.
      ignored: ["**/cloud-led-config.yaml", "**/recovery/**"],
    },
  },
});

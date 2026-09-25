import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceSnapshots } from "../../scripts/source-snapshots.mjs";

export default defineConfig(({ mode }) => ({
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react(), ...(process.env.PAGES_BASE ? [sourceSnapshots("manual")] : [])],
  resolve: mode === "profile" ? { alias: { "react-dom/client": "react-dom/profiling" } } : {},
  build: { outDir: mode === "profile" ? "dist-profile" : "dist", manifest: true },
}));

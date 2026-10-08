import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceSnapshots } from "../../scripts/source-snapshots.mjs";

export default defineConfig(({ mode }) => ({
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react(), ...(mode === "production" ? [sourceSnapshots("baseline")] : [])],
  resolve:
    mode === "profile" || mode === "profile-tracks" || mode === "profile-granular"
      ? { alias: { "react-dom/client": "react-dom/profiling" } }
      : {},
  build: {
    outDir:
      mode === "profile-granular"
        ? "dist-profile-granular"
        : mode === "profile-tracks"
          ? "dist-profile-tracks"
          : mode === "profile"
            ? "dist-profile"
            : "dist",
    manifest: true,
  },
}));

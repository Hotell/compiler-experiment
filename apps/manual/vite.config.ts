import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceSnapshots } from "../../scripts/source-snapshots.mjs";
import { rowMemoAblation } from "./row-ablation.mjs";

export default defineConfig((env) => {
  const ablation = rowMemoAblation(env);
  return {
    base: process.env.PAGES_BASE ?? "/",
    define: { __ROW_MEMO_ENABLED__: ablation.enabled },
    plugins: [
      react(),
      ...ablation.plugins,
      ...(env.mode === "production" && process.env.ROW_MEMO_ABLATION === undefined
        ? [sourceSnapshots("manual")]
        : []),
    ],
    resolve: env.mode === "profile" ? { alias: { "react-dom/client": "react-dom/profiling" } } : {},
    build: { outDir: ablation.outDir, manifest: true },
  };
});

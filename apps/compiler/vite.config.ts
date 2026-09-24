import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react({ compiler: { compilationMode: "infer", logDiagnostics: true } })],
  resolve: mode === "profile" ? { alias: { "react-dom/client": "react-dom/profiling" } } : {},
  build: { outDir: mode === "profile" ? "dist-profile" : "dist", manifest: true },
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "../../scripts/benchmark-provenance.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** @param {import("vite").ConfigEnv} config */
export function rowMemoAblation({ command, mode }, environment = process.env) {
  const arm = environment.ROW_MEMO_ABLATION;
  if (arm !== undefined) {
    if (arm !== "on" && arm !== "off")
      throw new Error("ROW_MEMO_ABLATION must be exactly 'on' or 'off' when defined");
    if (command !== "build") throw new Error("ROW_MEMO_ABLATION is only supported by vite build");
    if (mode !== "production" && mode !== "profile")
      throw new Error("ROW_MEMO_ABLATION requires production or profile mode");
    if (environment.PAGES_BASE !== undefined)
      throw new Error("ROW_MEMO_ABLATION cannot be combined with PAGES_BASE");
    if (environment.NODE_ENV !== undefined && environment.NODE_ENV !== "production")
      throw new Error("ROW_MEMO_ABLATION requires NODE_ENV=production when defined");
  }

  /** @type {import("vite").Plugin[]} */
  const plugins = [];
  if (arm !== undefined) {
    let fingerprint;
    plugins.push({
      name: "manual-row-memo-metadata",
      apply: "build",
      buildStart() {
        fingerprint = sourceFingerprint();
      },
      generateBundle() {
        if (!fingerprint || sourceFingerprint() !== fingerprint)
          throw new Error("Row-memo ablation sources changed during the build; rebuild both arms");
        const manifest = JSON.parse(
          readFileSync(resolve(projectRoot, "apps/manual/package.json"), "utf8"),
        );
        const reactVersion = manifest.dependencies.react;
        if (reactVersion !== "19.3.0" || manifest.dependencies["react-dom"] !== reactVersion)
          throw new Error("Row-memo ablation requires React and React DOM 19.3.0");
        this.emitFile({
          type: "asset",
          fileName: "ablation.json",
          source:
            JSON.stringify(
              {
                schemaVersion: 1,
                experiment: "manual-row-memo",
                arm,
                mode,
                reactVersion,
                sourceFingerprint: fingerprint,
              },
              null,
              2,
            ) + "\n",
        });
      },
    });
  }
  return {
    enabled: arm !== "off",
    outDir:
      arm === undefined
        ? mode === "profile"
          ? "dist-profile"
          : "dist"
        : `dist-ablation/${arm}/${mode}`,
    plugins,
  };
}

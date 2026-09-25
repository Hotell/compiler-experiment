import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const root = fileURLToPath(new URL("../", import.meta.url));

export function sourceSnapshots(app) {
  const sourcePaths = {
    App: app === "manual" ? "apps/manual/src/App.tsx" : "shared/App.tsx",
    providers: app === "manual" ? "apps/manual/src/providers.tsx" : "shared/providers.tsx",
    controls: "shared/controls.tsx",
    incidents: "shared/incidents.ts",
    main: `apps/${app}/src/main.tsx`,
    recorder: "benchmark/recorder.tsx",
  };
  const names = new Map(
    Object.entries(sourcePaths).map(([name, path]) => [resolve(root, path), name]),
  );
  const snapshots = new Map();

  return {
    name: "source-snapshots",
    apply: "build",
    enforce: "post",
    transform(code, id) {
      const name = names.get(id.split("?")[0]);
      if (name) snapshots.set(name, code);
    },
    async generateBundle() {
      for (const [path, name] of names) {
        const code = snapshots.get(name);
        if (!code) this.error(`Missing transformed source: ${path}`);
        const result = await format(`${name}.js`, code);
        if (result.errors.length) this.error(`Could not format transformed source: ${path}`);
        this.emitFile({ type: "asset", fileName: `sources/${name}.js`, source: result.code });
      }
    },
  };
}

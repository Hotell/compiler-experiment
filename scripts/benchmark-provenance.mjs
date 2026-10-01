import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const apps = ["compiler", "manual", "baseline"];
export const measurementFiles = [
  "measurements.json",
  "slowdown.json",
  "selection-latency.json",
  "filtering-latency.json",
  "lighthouse.json",
  "load-memory.json",
  ...apps.flatMap((app) => [`favorite-${app}.cpuprofile`, `lighthouse-${app}.json`]),
];

function collect(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collect(root, path);
    assert.ok(entry.isFile(), `Unsupported benchmark input: ${path}`);
    return [path];
  });
}

export function hashFiles(root, paths) {
  return Object.fromEntries(
    [...new Set(paths)].sort().map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex"),
    ]),
  );
}

export function sourceFingerprint(root = projectRoot) {
  const paths = [
    "package.json",
    "yarn.lock",
    "playwright.config.ts",
    "playwright.ablation.config.ts",
    "apps/manual/row-ablation.mjs",
    "scripts/benchmark-provenance.mjs",
    "scripts/run-benchmark.mjs",
    "scripts/source-snapshots.mjs",
    "benchmark/recorder.tsx",
    "benchmark/collection.ts",
    "benchmark/fiber-recorder.ts",
    ...apps.flatMap((app) => [
      ...["index.html", "package.json", "tsconfig.json", "vite.config.ts"].map(
        (name) => `apps/${app}/${name}`,
      ),
      ...collect(root, `apps/${app}/src`),
    ]),
    ...collect(root, "shared"),
    ...readdirSync(resolve(root, "benchmark"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `benchmark/${entry.name}`),
  ];
  return createHash("sha256")
    .update(JSON.stringify(hashFiles(root, paths)))
    .digest("hex");
}

export function comparisonBuilds(root = projectRoot) {
  return Object.fromEntries(
    apps.map((app) => [
      app,
      Object.fromEntries(
        ["production", "profile"].map((mode) => {
          const directory = resolve(
            root,
            `apps/${app}/${mode === "profile" ? "dist-profile" : "dist"}`,
          );
          return [mode, hashFiles(directory, collect(directory, "."))];
        }),
      ),
    ]),
  );
}

export function validateProvenance(provenance, directory, fingerprint = sourceFingerprint()) {
  assert.equal(provenance?.schemaVersion, 1, "Missing benchmark provenance; rerun yarn benchmark");
  assert.equal(
    provenance.sourceFingerprint,
    fingerprint,
    "Benchmark sources changed; rerun yarn benchmark before reporting or publishing",
  );
  assert.deepEqual(
    provenance.measurements,
    hashFiles(directory, measurementFiles),
    "Benchmark measurements changed or were mixed across runs; rerun yarn benchmark",
  );
}

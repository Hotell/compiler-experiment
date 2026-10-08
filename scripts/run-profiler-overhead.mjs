import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { sourceFingerprint } from "./benchmark-provenance.mjs";
import { resultsDirectory } from "./benchmark-results.mjs";
import {
  profilerApps,
  profilerArms,
  profilerBuilds,
  profilerDirectories,
  profilerProtocolFingerprint,
  readProfilerEvidence,
  writeProfilerReport,
} from "./profiler-overhead.mjs";

assert.equal(
  process.cwd(),
  fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
  "Run the profiler experiment from its worktree root",
);
const results = resultsDirectory();
const directory = `${results}/profiler-overhead`;
const traces = process.argv.includes("--tracks");
const env = { ...process.env, BENCHMARK_RESULTS_DIR: results, PROFILER_TRACKS: traces ? "1" : "0" };
const fingerprint = sourceFingerprint();
const protocolFingerprint = profilerProtocolFingerprint();
if (!traces) rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
for (const app of profilerApps)
  for (const arm of profilerArms) {
    const config = await resolveConfig(
      { root: `apps/${app}`, mode: arm, logLevel: "silent" },
      "build",
      arm,
      "production",
    );
    assert.equal(config.isProduction, true);
    const alias = config.resolve.alias.find(
      (item) => item.find === "react-dom/client",
    )?.replacement;
    assert.equal(alias, arm !== "production" ? "react-dom/profiling" : undefined);
  }
for (const arm of profilerArms)
  execFileSync("yarn", ["workspace", "@experiment/baseline", "build", "--mode", arm], {
    stdio: "inherit",
    env,
  });
const builds = profilerBuilds();
for (const arm of profilerArms)
  for (const file of builds.baseline[arm].bundle.files.js)
    assert.doesNotMatch(
      readFileSync(`apps/baseline/${profilerDirectories[arm]}/${file}`, "utf8"),
      /__benchmark|__fiberBenchmark|__REACT_SCAN__|react-scan/,
      "Measured builds must omit recorder/Scan",
    );
if (traces && existsSync(`${directory}/provenance.json`)) {
  const evidence = readProfilerEvidence(directory);
  assert.deepEqual(
    evidence.provenance.builds,
    builds,
    "Trace capture must use the measured builds",
  );
}
writeFileSync(`${directory}/builds.json`, `${JSON.stringify(builds, null, 2)}\n`);
execFileSync("yarn", ["playwright", "test", "--config", "playwright.profiler.config.ts"], {
  stdio: "inherit",
  env,
});
assert.equal(sourceFingerprint(), fingerprint, "Sources changed during profiler measurement");
assert.equal(
  profilerProtocolFingerprint(),
  protocolFingerprint,
  "Profiler collector changed during measurement",
);
assert.deepEqual(profilerBuilds(), builds, "Builds changed during profiler measurement");
if (existsSync(`${directory}/measurements.json`)) writeProfilerReport(directory);
console.log(`Profiler ${traces ? "tracks" : "overhead"} evidence: ${directory}`);

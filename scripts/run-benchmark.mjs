import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  comparisonBuilds,
  hashFiles,
  measurementFiles,
  sourceFingerprint,
} from "./benchmark-provenance.mjs";

const fingerprint = sourceFingerprint();
for (const args of [["build"], ["exec", "node", "scripts/check-transform.mjs"], ["build:profile"]])
  execFileSync("yarn", args, { stdio: "inherit" });
const builds = comparisonBuilds();
execFileSync("yarn", ["playwright", "test"], { stdio: "inherit" });
assert.equal(sourceFingerprint(), fingerprint, "Sources changed during benchmark; rerun");
assert.deepEqual(comparisonBuilds(), builds, "Builds changed during benchmark; rerun");
const directory = "benchmark/results";
mkdirSync(directory, { recursive: true });
writeFileSync(
  `${directory}/provenance.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceFingerprint: fingerprint,
      builds,
      measurements: hashFiles(directory, measurementFiles),
    },
    null,
    2,
  )}\n`,
);

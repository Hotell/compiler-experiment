import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";

const check = spawnSync(
  "./node_modules/.bin/oxlint",
  ["--no-ignore", "benchmark/fixtures/invalid-immutability.tsx"],
  { encoding: "utf8" },
);
assert.equal(check.status, 1, `Expected invalid fixture to fail lint: ${check.stderr}`);
assert.match(
  check.stdout + check.stderr,
  /react(?:\/immutability|\(immutability\))/,
  "The React immutability rule must reject the fixture",
);
console.log("React immutability negative fixture rejected as expected.");

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { analyzeRowAblation, actionNames, arms } from "./row-ablation.mjs";
import { measureBundle } from "./bundle-size.mjs";

function fixture() {
  const sourceFingerprint = "a".repeat(64);
  const builds = Object.fromEntries(
    arms.map((arm) => [
      arm,
      Object.fromEntries(
        ["production", "profile"].map((mode) => [
          mode,
          {
            schemaVersion: 1,
            experiment: "manual-row-memo",
            arm,
            mode,
            sourceFingerprint,
            reactVersion: "19.3.0",
          },
        ]),
      ),
    ]),
  );
  const actions = (make) =>
    actionNames.map((name, index) => ({ name, state: name, ...make(index) }));
  return {
    schemaVersion: 1,
    experiment: "manual-row-memo",
    sourceFingerprint,
    browser: "test-browser",
    reactVersion: "19.3.0",
    cpuRate: 4,
    viewport: { width: 1440, height: 900 },
    seed: 20260929,
    blocks: 3,
    pairsPerBlock: 10,
    warmupsPerArm: 1,
    builds,
    profileRuns: Array.from({ length: 3 }, (_, repeat) => ({
      repeat,
      order: repeat % 2 ? ["off", "on"] : ["on", "off"],
      arms: Object.fromEntries(
        arms.map((arm) => [
          arm,
          {
            actions: actions((index) => ({
              records: [
                {
                  id: "root",
                  phase: "update",
                  actualDuration: arm === "on" ? 0 : 2,
                  baseDuration: 7,
                  startTime: index + 1,
                  commitTime: index + 2,
                  rootId: "root",
                  rootGeneration: 1,
                  boundaryGeneration: 1,
                  commitSequence: index + 2,
                },
              ],
              fiberRenders: [],
              fiberCommits: [],
            })),
          },
        ]),
      ),
    })),
    pairs: Array.from({ length: 30 }, (_, index) => ({
      block: Math.floor(index / 10),
      pair: index % 10,
      order: index % 2 ? ["off", "on"] : ["on", "off"],
      arms: Object.fromEntries(
        arms.map((arm) => [
          arm,
          {
            actions: actions(() => ({
              domMs: arm === "on" ? 10 : 11 + Math.floor(index / 10),
              frameMs: arm === "on" ? 20 : 21 + Math.floor(index / 10),
            })),
          },
        ]),
      ),
    })),
  };
}

test("paired effect uses off-minus-on and three block means, not 30 independent trials", () => {
  const report = analyzeRowAblation(fixture());
  const effect = report.timings[0].dom.pairedSavingsMs;
  assert.equal(effect.mean, 2);
  assert.equal(effect.median, 2);
  assert.deepEqual(effect.blockMeans, [1, 2, 3]);
  const margin = 4.302652729911275 / Math.sqrt(3);
  for (const [index, expected] of [2 - margin, 2 + margin].entries())
    assert.ok(Math.abs(effect.blockMean95CI[index] - expected) < 1e-12);
  assert.ok(effect.blockMean95CI[0] < 0, "A small effect is inconclusive under block uncertainty");
  assert.match(report.design.interval, /not 30 independent/);
});

test("pair matching avoids subtraction of unpaired medians", () => {
  const input = fixture();
  for (const pair of input.pairs) {
    for (const [index, action] of pair.arms.on.actions.entries()) {
      action.domMs = pair.pair === 0 ? 100 : 10;
      pair.arms.off.actions[index].domMs = pair.pair === 0 ? 90 : 12;
      action.frameMs = 200;
      pair.arms.off.actions[index].frameMs = 200;
    }
  }
  const timing = analyzeRowAblation(input).timings[0].dom;
  assert.equal(timing.off.medianMs - timing.on.medianMs, 2);
  assert.ok(Math.abs(timing.pairedSavingsMs.mean - 0.8) < 1e-12);
});

test("zero durations and independent actual/base profiling values survive", () => {
  const input = fixture();
  input.pairs[0].arms.on.actions[0].domMs = 0;
  input.pairs[0].arms.on.actions[0].frameMs = 0;
  const report = analyzeRowAblation(input);
  assert.equal(report.profiling.on[0].medianDurationMs.root, 0);
  assert.equal(report.profiling.on[0].medianBaseDurationMs.root, 7);
  assert.equal(report.profiling.off[0].medianDurationMs.root, 2);
  assert.equal(report.profiling.off[0].medianBaseDurationMs.root, 7);
  assert.equal(report.profiling.on[0].medianDurationMs.list, null);
});

test("paired effects retain negative and zero savings without declaring a winner", () => {
  for (const difference of [-2, 0, 2]) {
    const input = fixture();
    for (const pair of input.pairs) {
      for (const [index, action] of pair.arms.off.actions.entries())
        action.domMs = pair.arms.on.actions[index].domMs + difference;
    }
    const result = analyzeRowAblation(input).timings[0].dom;
    assert.equal(result.pairedSavingsMs.mean, difference);
    assert.deepEqual(result.pairedSavingsMs.blockMean95CI, [difference, difference]);
    assert.equal(Object.hasOwn(result, "winner"), false);
  }
});

for (const [name, change, pattern] of [
  ["unknown schema", (input) => (input.schemaVersion = 2), /unsupported schema/],
  [
    "mixed sources",
    (input) => (input.builds.off.profile.sourceFingerprint = "b".repeat(64)),
    /Mixed build sources/,
  ],
  ["wrong arm provenance", (input) => (input.builds.off.production.arm = "on"), /off/],
  ["missing pairs", (input) => input.pairs.pop(), /Thirty complete/],
  ["duplicate pair", (input) => (input.pairs[1].pair = 0), /Duplicate paired/],
  ["missing profile repetition", (input) => input.profileRuns.pop(), /Three native/],
  [
    "mismatched DOM",
    (input) => (input.pairs[0].arms.off.actions[0].state = "different"),
    /Behavior mismatch/,
  ],
  ["unbalanced order", (input) => (input.pairs[0].order = ["off", "on"]), /Unbalanced order/],
  [
    "incorrect arm order",
    (input) => (input.pairs[0].order = ["on", "on"]),
    /Invalid paired arm order/,
  ],
  ["missing action", (input) => input.pairs[0].arms.on.actions.pop(), /Incomplete on action/],
  [
    "missing baseDuration",
    (input) => delete input.profileRuns[0].arms.on.actions[0].records[0].baseDuration,
    /baseDuration/,
  ],
  ["invalid duration", (input) => (input.pairs[0].arms.on.actions[0].domMs = NaN), /Invalid DOM/],
  ["negative duration", (input) => (input.pairs[0].arms.on.actions[0].domMs = -1), /Invalid DOM/],
  [
    "frame before DOM",
    (input) => (input.pairs[0].arms.on.actions[0].frameMs = 1),
    /Invalid two-frame/,
  ],
]) {
  test(`rejects ${name} rather than fabricating a result`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => analyzeRowAblation(input), pattern);
  });
}

test("initial-load bundles deduplicate shared static assets and exclude dynamic/source-map files", () => {
  const directory = mkdtempSync(join(tmpdir(), "row-memo-bundle-"));
  try {
    mkdirSync(join(directory, ".vite"));
    const manifest = {
      entry: {
        isEntry: true,
        file: "entry.js",
        imports: ["shared", "other"],
        css: ["style.css"],
        dynamicImports: ["later"],
      },
      shared: { file: "shared.js", css: ["style.css"] },
      other: { file: "other.js", imports: ["shared"] },
      later: { file: "later.js" },
    };
    writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify(manifest));
    const content = {
      "entry.js": "entry",
      "shared.js": "shared",
      "other.js": "other",
      "style.css": "style",
      "later.js": "excluded",
      "entry.js.map": "excluded map",
    };
    for (const [path, value] of Object.entries(content))
      writeFileSync(join(directory, path), value);
    const bundle = measureBundle(directory);
    assert.equal(bundle.js.raw, 5 + 6 + 5);
    assert.equal(
      bundle.js.gzip,
      ["entry", "shared", "other"].reduce((sum, value) => sum + gzipSync(value).length, 0),
    );
    assert.equal(bundle.css.raw, 5);
    assert.deepEqual(bundle.loadedLater, ["later"]);
    manifest.entry.imports.push("missing");
    writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify(manifest));
    assert.throws(() => measureBundle(directory), /missing manifest chunk/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

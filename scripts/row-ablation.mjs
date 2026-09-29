import { strict as assert } from "node:assert";
import { countProfileRecords, median, summarizeProfileSamples } from "./profile-counts.mjs";

export const arms = ["on", "off"];
export const actionNames = ["switch queue", "select incident", "favorite incident"];
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function pairedEffect(pairs, actionIndex, metric) {
  const values = (arm) => pairs.map((pair) => pair.arms[arm].actions[actionIndex][metric]);
  const differences = pairs.map(
    (pair) =>
      pair.arms.off.actions[actionIndex][metric] - pair.arms.on.actions[actionIndex][metric],
  );
  const blockMeans = [0, 1, 2].map((block) =>
    mean(differences.filter((_, index) => pairs[index].block === block)),
  );
  const average = mean(blockMeans);
  const variance = blockMeans.reduce((sum, value) => sum + (value - average) ** 2, 0) / 2;
  // Student-t(0.975, df=2), using blocks rather than treating 30 trials as independent.
  const margin = 4.302652729911275 * Math.sqrt(variance / 3);
  return {
    on: { medianMs: median(values("on")), meanMs: mean(values("on")) },
    off: { medianMs: median(values("off")), meanMs: mean(values("off")) },
    pairedSavingsMs: {
      median: median(differences),
      mean: average,
      blockMeans,
      blockMean95CI: [average - margin, average + margin],
    },
  };
}

export function analyzeRowAblation(input) {
  assert.equal(input?.schemaVersion, 1, "Regenerate row-memo measurements: unsupported schema");
  assert.equal(input.experiment, "manual-row-memo");
  assert.match(input.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(typeof input.browser === "string" && input.browser.length > 0);
  assert.ok(typeof input.reactVersion === "string" && input.reactVersion.length > 0);
  assert.equal(input.cpuRate, 4);
  assert.deepEqual(input.viewport, { width: 1440, height: 900 });
  assert.ok(Number.isSafeInteger(input.seed) && input.seed > 0);
  assert.equal(input.blocks, 3);
  assert.equal(input.pairsPerBlock, 10);
  assert.equal(input.warmupsPerArm, 1);
  for (const arm of arms) {
    for (const mode of ["production", "profile"]) {
      const build = input.builds?.[arm]?.[mode];
      assert.equal(build?.schemaVersion, 1, `Missing ${arm}/${mode} build provenance`);
      assert.equal(build.experiment, input.experiment);
      assert.equal(build.arm, arm);
      assert.equal(build.mode, mode);
      assert.equal(build.reactVersion, input.reactVersion);
      assert.equal(build.sourceFingerprint, input.sourceFingerprint, "Mixed build sources");
    }
  }
  function validateArms(sample) {
    assert.deepEqual([...sample.order].sort(), [...arms].sort(), "Invalid paired arm order");
    for (const arm of arms) {
      assert.deepEqual(
        sample.arms?.[arm]?.actions?.map((action) => action.name),
        actionNames,
        `Incomplete ${arm} action sequence`,
      );
    }
    for (const index of actionNames.keys()) {
      const on = sample.arms.on.actions[index].state;
      const off = sample.arms.off.actions[index].state;
      assert.ok(typeof on === "string" && on.length > 0, "Missing behavior snapshot");
      assert.equal(on, off, `Behavior mismatch for ${actionNames[index]}`);
    }
  }

  assert.equal(input.profileRuns?.length, 3, "Three native profiling repetitions required");
  for (const [index, run] of input.profileRuns.entries()) {
    assert.equal(run.repeat, index, "Invalid profile repetition identity");
    validateArms(run);
    for (const arm of arms) {
      for (const action of run.arms[arm].actions) {
        assert.ok(action.records?.some((record) => record.id === "root"));
        countProfileRecords(action.records, action.fiberRenders);
      }
    }
  }
  assert.equal(input.pairs?.length, 30, "Thirty complete paired production trials required");
  const identities = new Set();
  for (const pair of input.pairs) {
    assert.ok(Number.isInteger(pair.block) && pair.block >= 0 && pair.block < 3);
    assert.ok(Number.isInteger(pair.pair) && pair.pair >= 0 && pair.pair < 10);
    const id = `${pair.block}:${pair.pair}`;
    assert.ok(!identities.has(id), `Duplicate paired trial ${id}`);
    identities.add(id);
    validateArms(pair);
    for (const arm of arms) {
      for (const sample of pair.arms[arm].actions) {
        assert.ok(Number.isFinite(sample.domMs) && sample.domMs >= 0, "Invalid DOM duration");
        assert.ok(
          Number.isFinite(sample.frameMs) && sample.frameMs >= sample.domMs,
          "Invalid two-frame opportunity duration",
        );
      }
    }
  }
  for (const block of [0, 1, 2]) {
    const trials = input.pairs.filter((pair) => pair.block === block);
    assert.equal(trials.length, 10);
    assert.equal(trials.filter((pair) => pair.order[0] === "on").length, 5, "Unbalanced order");
  }

  return {
    schemaVersion: 1,
    experiment: input.experiment,
    browser: input.browser,
    reactVersion: input.reactVersion,
    sourceFingerprint: input.sourceFingerprint,
    design: {
      cpuRate: input.cpuRate,
      viewport: input.viewport,
      seed: input.seed,
      blocks: input.blocks,
      pairsPerBlock: input.pairsPerBlock,
      warmupsPerArm: input.warmupsPerArm,
      difference: "off minus on; positive milliseconds favor row memo",
      interval:
        "Exploratory 95% Student-t interval on three fresh-context block mean paired differences (df=2), not 30 independent trials. Independence/normality of block effects is assumed; all blocks share one browser/hardware session. No equivalence claim or timing gate.",
    },
    profiling: Object.fromEntries(
      arms.map((arm) => [
        arm,
        actionNames.map((name, index) => ({
          name,
          ...summarizeProfileSamples(
            input.profileRuns.map((run) => {
              const sample = run.arms[arm].actions[index];
              return countProfileRecords(sample.records, sample.fiberRenders);
            }),
          ),
        })),
      ]),
    ),
    timings: actionNames.map((name, index) => ({
      name,
      dom: pairedEffect(input.pairs, index, "domMs"),
      frameOpportunity: pairedEffect(input.pairs, index, "frameMs"),
    })),
  };
}

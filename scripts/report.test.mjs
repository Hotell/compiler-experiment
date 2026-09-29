import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { lexer } from "marked";
import {
  countProfileRecords,
  summarizeProfileSamples,
  validateProfileRecords,
} from "./profile-counts.mjs";
import "./profile-counts.test.mjs";

test("comparison explains load, Lighthouse, CPU traces and the decision", () => {
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.versions.react, "19.3.0");
  assert.match(markdown, /React 19\.3\.0 profiling fiber/);
  const tables = lexer(markdown, { gfm: true }).filter((token) => token.type === "table");
  assert.equal(tables.length, 7, "all comparison tables must render as GFM tables");
  for (const table of tables) {
    assert.ok(table.rows.every((row) => row.length === table.header.length));
  }
  assert.match(markdown, /## Evaluation/);
  assert.match(markdown, /## Component work and committed updates/);
  assert.match(markdown, /## Selection responsiveness/);
  assert.match(markdown, /## User-perceived load time/);
  assert.match(markdown, /## Lighthouse/);
  assert.match(markdown, /## CPU slowdown/);
  assert.match(markdown, /## Post-GC JS heap/);
  assert.match(markdown, /raw \/ gzip \(kB\)/);
  assert.doesNotMatch(markdown, /gzip bytes/);
  assert.match(markdown, /Row component work \(C \/ M \/ B\)/);
  assert.match(markdown, /Queue component work \(C \/ M \/ B\)/);
  assert.match(markdown, /JS-active sampled time/);
  assert.match(markdown, /BASE \(baseDuration\).*estimate/);
  assert.match(markdown, /BASE minus ACTUAL is not measured savings/);
  assert.match(markdown, /medianBaseDurationMs/);
  assert.match(markdown, /null means no matching callback.*0 is a measured zero/);
  assert.match(markdown, /Overlapping root\/parent\/child durations are never summed/);
  assert.match(markdown, /\[rootId, rootGeneration, commitSequence\]/);
  assert.match(markdown, /\[measurements\.json\]\(measurements\.json\)/);
  assert.ok(report.evaluation?.recommendation);
  assert.equal(
    report.evaluation.recommendation,
    "No demonstrated selection-speed winner between compiler and manual; manual ships the smaller bundle.",
  );
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(report.bundles[app].total.gzip > 0);
    assert.ok(report.actions[app].find((action) => action.name === "select incident"));
    assert.ok(report.load[app].medianMs > 0);
    assert.equal(report.interactions.selection[app].runs.length, 20);
    assert.ok(report.interactions.selection[app].medianDomMs > 0);
    assert.ok(report.interactions.selection[app].medianPaintMs > 0);
    assert.ok(report.memory[app].beforeBytes > 0);
    assert.ok(report.memory[app].afterBytes > 0);
    assert.ok(report.lighthouse[app].performanceScore >= 0);
    assert.match(markdown, new RegExp(`!\\[${app} CPU flame chart\\]`));
    assert.ok(existsSync(`benchmark/results/favorite-${app}.svg`));
  }
  const selected = (app) => report.actions[app].find((action) => action.name === "select incident");
  assert.equal(selected("compiler").rowRenders, 67);
  assert.equal(selected("manual").rowRenders, 1);
  assert.equal(selected("baseline").rowRenders, 67);
  assert.doesNotMatch(report.evaluation.recommendation, /avoids more row work/);
  for (const [app, expected] of [
    ["compiler", 4],
    ["manual", 2],
    ["baseline", 4],
  ]) {
    assert.equal(
      report.actions[app].find((action) => action.name === "switch queue").queueRenders,
      expected,
    );
  }
  assert.ok(selected("baseline").openButtonRenders > selected("manual").openButtonRenders);
  assert.ok(
    report.actions.baseline.find((action) => action.name === "favorite incident")
      .openButtonRenders >
      report.actions.manual.find((action) => action.name === "favorite incident").openButtonRenders,
  );
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(
      report.actions[app].find((action) => action.name === "favorite incident")
        .favoriteButtonRenders > 0,
    );
  }
  assert.match(markdown, /Open button work \(C \/ M \/ B\) \| Favorite button work/);
  assert.ok(Number.isFinite(report.baselineDeltas.compiler.total.gzip.bytes));
});

test("comparison preserves schema-v2 root phases and independent actual/base summaries", () => {
  const input = JSON.parse(readFileSync("benchmark/results/measurements.json", "utf8"));
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  assert.equal(input.schemaVersion, 2);
  assert.equal(report.schemaVersion, 2);
  const keys = [
    "root",
    "shell",
    "toolbar",
    "list",
    "detail",
    "rows",
    "queueItems",
    "openButtons",
    "favoriteButtons",
  ];
  for (const app of ["compiler", "manual", "baseline"]) {
    for (const repetition of input.repetitions) {
      validateProfileRecords(repetition[app].actions.flatMap((action) => action.records));
    }
    assert.equal(report.actions[app].length, input.repetitions[0][app].actions.length);
    for (const [index, action] of report.actions[app].entries()) {
      const samples = input.repetitions.map((repetition) => {
        const raw = repetition[app].actions[index];
        assert.equal(action.name, raw.name);
        return countProfileRecords(raw.records, raw.fiberRenders);
      });
      assert.deepEqual(action, { name: action.name, ...summarizeProfileSamples(samples) });
      for (const summary of [action, action.mounts]) {
        assert.deepEqual(Object.keys(summary.medianDurationMs), keys);
        assert.deepEqual(Object.keys(summary.medianBaseDurationMs), keys);
      }
      for (const run of action.runs) {
        assert.equal(
          run.commits,
          Object.values(run.rootPhaseCounts).reduce((sum, count) => sum + count, 0),
        );
        assert.equal(run.root, run.rootPhaseCounts.update + run.rootPhaseCounts["nested-update"]);
        assert.equal(run.mounts.root, run.rootPhaseCounts.mount);
      }
    }
  }
});

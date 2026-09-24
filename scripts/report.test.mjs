import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";

test("comparison explains load, Lighthouse, CPU traces and the decision", () => {
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  assert.match(markdown, /## Evaluation/);
  assert.match(markdown, /## User-perceived load time/);
  assert.match(markdown, /## Lighthouse/);
  assert.match(markdown, /## CPU slowdown/);
  assert.ok(report.evaluation?.recommendation);
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(report.bundles[app].total.gzip > 0);
    assert.ok(report.actions[app].find((action) => action.name === "select incident"));
    assert.ok(report.load[app].medianMs > 0);
    assert.ok(report.lighthouse[app].performanceScore >= 0);
    assert.match(markdown, new RegExp(`!\\[${app} CPU flame chart\\]`));
    assert.ok(existsSync(`benchmark/results/favorite-${app}.svg`));
  }
  assert.ok(
    report.actions.baseline.find((action) => action.name === "select incident").rows >
      report.actions.manual.find((action) => action.name === "select incident").rows,
  );
  assert.ok(
    report.actions.baseline.find((action) => action.name === "select incident").openButtons >
      report.actions.manual.find((action) => action.name === "select incident").openButtons,
  );
  assert.ok(
    report.actions.baseline.find((action) => action.name === "favorite incident").openButtons >
      report.actions.manual.find((action) => action.name === "favorite incident").openButtons,
  );
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(
      report.actions[app].find((action) => action.name === "favorite incident").favoriteButtons > 0,
    );
  }
  assert.match(markdown, /Open buttons \| Favorite buttons/);
  assert.ok(Number.isFinite(report.baselineDeltas.compiler.total.gzip.bytes));
});

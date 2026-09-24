import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { lexer } from "marked";

test("comparison explains load, Lighthouse, CPU traces and the decision", () => {
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
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

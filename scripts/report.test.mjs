import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { lexer } from "marked";

test("comparison explains load, Lighthouse, CPU traces and the decision", () => {
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  const tables = lexer(markdown, { gfm: true }).filter((token) => token.type === "table");
  assert.equal(tables.length, 6, "all comparison tables must render as GFM tables");
  for (const table of tables) {
    assert.ok(table.rows.every((row) => row.length === table.header.length));
  }
  assert.match(markdown, /## Evaluation/);
  assert.match(markdown, /## User-perceived load time/);
  assert.match(markdown, /## Lighthouse/);
  assert.match(markdown, /## CPU slowdown/);
  assert.match(markdown, /## Post-GC JS heap/);
  assert.match(markdown, /raw \/ gzip \(kB\)/);
  assert.doesNotMatch(markdown, /gzip bytes/);
  assert.match(markdown, /Rows \(C \/ M \/ B\)/);
  assert.match(markdown, /Queue items \(C \/ M \/ B\)/);
  assert.match(markdown, /JS-active sampled time/);
  assert.ok(report.evaluation?.recommendation);
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(report.bundles[app].total.gzip > 0);
    assert.ok(report.actions[app].find((action) => action.name === "select incident"));
    assert.ok(report.load[app].medianMs > 0);
    assert.ok(report.memory[app].beforeBytes > 0);
    assert.ok(report.memory[app].afterBytes > 0);
    assert.ok(report.lighthouse[app].performanceScore >= 0);
    assert.match(markdown, new RegExp(`!\\[${app} CPU flame chart\\]`));
    assert.ok(existsSync(`benchmark/results/favorite-${app}.svg`));
  }
  assert.ok(
    report.actions.baseline.find((action) => action.name === "select incident").rows >
      report.actions.manual.find((action) => action.name === "select incident").rows,
  );
  for (const [app, expected] of [
    ["compiler", 2],
    ["manual", 2],
    ["baseline", 4],
  ]) {
    assert.equal(
      report.actions[app].find((action) => action.name === "switch queue").queueItems,
      expected,
    );
  }
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
  assert.match(markdown, /Open buttons \(C \/ M \/ B\) \| Favorite buttons/);
  assert.ok(Number.isFinite(report.baselineDeltas.compiler.total.gzip.bytes));
});

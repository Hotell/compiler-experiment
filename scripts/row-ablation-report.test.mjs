import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lexer } from "marked";
import { analyzeRowAblation } from "./row-ablation.mjs";
import { measureBundle } from "./bundle-size.mjs";
import { hashFiles } from "./benchmark-provenance.mjs";

test("ablation artifacts retain paired uncertainty, raw actual/base evidence and isolated bytes", () => {
  const directory = "benchmark/results/row-memo";
  const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
  const report = JSON.parse(readFileSync(`${directory}/comparison.json`, "utf8"));
  const markdown = readFileSync(`${directory}/comparison.md`, "utf8");
  const html = readFileSync(`${directory}/report.html`, "utf8");
  const recomputed = analyzeRowAblation(input);
  for (const [key, value] of Object.entries(recomputed)) assert.deepEqual(report[key], value);
  for (const arm of ["on", "off"]) {
    assert.deepEqual(
      report.bundles[arm],
      measureBundle(`apps/manual/dist-ablation/${arm}/production`),
    );
    assert.deepEqual(
      report.productionFiles[arm],
      hashFiles(
        `apps/manual/dist-ablation/${arm}/production`,
        Object.values(report.bundles[arm].files).flat(),
      ),
    );
  }
  for (const kind of ["js", "css", "total"]) {
    for (const encoding of ["raw", "gzip"]) {
      assert.equal(
        report.bundleDeltaOnMinusOff[kind][encoding],
        report.bundles.on[kind][encoding] - report.bundles.off[kind][encoding],
      );
    }
  }
  assert.deepEqual(
    report.profiling.on.map((action) => action.rowRenders),
    [0, 1, 1],
  );
  assert.deepEqual(
    report.profiling.off.map((action) => action.rowRenders),
    [67, 67, 67],
  );
  for (const arm of ["on", "off"]) {
    assert.deepEqual(
      report.profiling[arm].map((action) => action.openButtonRenders),
      [0, 0, 0],
    );
    assert.deepEqual(
      report.profiling[arm].map((action) => action.favoriteButtonRenders),
      [0, 0, 1],
    );
  }
  assert.equal(lexer(markdown).filter((token) => token.type === "table").length, 3);
  assert.match(markdown, /not proof of no effect or equivalence/);
  assert.match(markdown, /not reproduce compiler caching/);
  assert.match(markdown, /baseDuration is an estimate/);
  assert.match(markdown, /not actual paint/);
  assert.match(markdown, /not the isolated size of React\.memo/);
  assert.match(html, /<table>/);
  assert.match(html, /href="measurements.json"/);
});

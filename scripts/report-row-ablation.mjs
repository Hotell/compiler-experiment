import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";
import { measureBundle } from "./bundle-size.mjs";
import { analyzeRowAblation, arms } from "./row-ablation.mjs";
import { hashFiles, sourceFingerprint } from "./benchmark-provenance.mjs";

const directory = "benchmark/results/row-memo";
const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
const report = analyzeRowAblation(input);
assert.equal(input.sourceFingerprint, sourceFingerprint(), "Sources changed since ablation; rerun");
for (const arm of arms) {
  for (const mode of ["production", "profile"]) {
    const current = JSON.parse(
      readFileSync(`apps/manual/dist-ablation/${arm}/${mode}/ablation.json`, "utf8"),
    );
    assert.deepEqual(current, input.builds[arm][mode], "Builds changed since measurement; rerun");
  }
}
report.bundles = Object.fromEntries(
  arms.map((arm) => [arm, measureBundle(`apps/manual/dist-ablation/${arm}/production`)]),
);
report.productionFiles = Object.fromEntries(
  arms.map((arm) => [
    arm,
    hashFiles(
      `apps/manual/dist-ablation/${arm}/production`,
      Object.values(report.bundles[arm].files).flat(),
    ),
  ]),
);
report.bundleDeltaOnMinusOff = Object.fromEntries(
  ["js", "css", "total"].map((kind) => [
    kind,
    Object.fromEntries(
      ["raw", "gzip"].map((encoding) => [
        encoding,
        report.bundles.on[kind][encoding] - report.bundles.off[kind][encoding],
      ]),
    ),
  ]),
);
const ms = (value) => value.toFixed(3);
const duration = (value) => (value === null ? "not observed" : ms(value));
const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
const interval = (values) => values.map(ms).join(" to ");
const rows = report.timings.flatMap((action) =>
  [
    ["DOM readiness", action.dom],
    ["Two-frame opportunity", action.frameOpportunity],
  ].map(
    ([label, metric]) =>
      `| ${action.name} | ${label} | ${ms(metric.on.medianMs)} | ${ms(metric.off.medianMs)} | ${ms(metric.pairedSavingsMs.mean)} | ${interval(metric.pairedSavingsMs.blockMean95CI)} |`,
  ),
);
const markdown = [
  "# Manual row memo ablation",
  "",
  "This is a separate manual-app experiment, not the compiler/manual/baseline comparison. Both arms use the same source and dependencies; only the outer IncidentRow memo wrapper differs. ON retains it; OFF executes the same row implementation without it. Provider values, callbacks, derived calculations, child button memoization, DOM and workflows are unchanged.",
  "",
  "Removing the row wrapper does not reproduce compiler caching inside the row. This experiment isolates that wrapper's contribution; it does not establish compiler equivalence.",
  "",
  "## Production responsiveness",
  "",
  `Chromium ${input.browser}; React ${input.reactVersion}; viewport ${input.viewport.width} x ${input.viewport.height}; 4x CDP CPU throttle. Three fresh-context blocks, ten paired trials per block, one warm-up workflow per arm per block. ON-first/OFF-first order is balanced and seeded-shuffled (seed ${input.seed}). Reset work occurs outside timing. All three actions run in the same order within each trial, and behavior snapshots match across arms.`,
  "",
  "Timers start in the target button's click listener before React's handler. DOM readiness stops when the intended DOM change is observed; the second animation-frame callback is only a presentation opportunity, not actual paint. Neither metric includes pre-dispatch input delay or measures INP. No React Profiler or fiber probe runs in the production timing pages.",
  "",
  "| Action | Metric | ON median (ms) | OFF median (ms) | Mean paired saving (ms) | Block-mean 95% interval (ms) |",
  "| --- | --- | ---: | ---: | ---: | ---: |",
  ...rows,
  "",
  "**Positive paired savings mean OFF was slower, favoring memo ON.** These are differences within matched trials, not subtraction of unpaired medians. The interval uses three block means and Student-t with 2 degrees of freedom; it does not treat 30 trials as independent. Only three blocks were collected in one browser/hardware session, so uncertainty is exploratory and rests on independence/normality assumptions. An interval spanning zero is inconclusive, not proof of no effect or equivalence. Intervals are unadjusted across the displayed endpoints; there is no automatic winner or speed gate.",
  "",
  "## Shipped bundle size",
  "",
  "Normal-production entry JavaScript, static imports and attached CSS are counted once. Gzip is measured per emitted file. Profiling builds, metadata, source maps and dynamic imports are excluded. ON-minus-OFF is a whole-build/minification delta, not the isolated size of React.memo itself.",
  "",
  "| Asset | ON raw / gzip (bytes) | OFF raw / gzip (bytes) | ON minus OFF raw / gzip (bytes) |",
  "| --- | ---: | ---: | ---: |",
  ...["js", "css", "total"].map(
    (kind) =>
      `| ${kind} | ${report.bundles.on[kind].raw} / ${report.bundles.on[kind].gzip} | ${report.bundles.off[kind].raw} / ${report.bundles.off[kind].gzip} | ${signed(report.bundleDeltaOnMinusOff[kind].raw)} / ${signed(report.bundleDeltaOnMinusOff[kind].gzip)} |`,
  ),
  "",
  "## Intervention check: native profiling builds",
  "",
  "Three profiling repetitions run without CPU throttling, separately from production timings. Row/button counts are the existing pinned-version React fiber diagnostic, not equivalent-cost CPU work or DOM mutations. Actual and base root/list durations remain in comparison.json; baseDuration is an estimate, not an uncached replay or measured savings. Inclusive parent/child durations are not added.",
  "",
  "| Action | Rows ON / OFF | Open buttons ON / OFF | Favorite buttons ON / OFF | List ACTUAL ON / OFF (ms) | List BASE ON / OFF (ms) |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...report.profiling.on.map((on, index) => {
    const off = report.profiling.off[index];
    return `| ${on.name} | ${on.rowRenders} / ${off.rowRenders} | ${on.openButtonRenders} / ${off.openButtonRenders} | ${on.favoriteButtonRenders} / ${off.favoriteButtonRenders} | ${duration(on.medianDurationMs.list)} / ${duration(off.medianDurationMs.list)} | ${duration(on.medianBaseDurationMs.list)} / ${duration(off.medianBaseDurationMs.list)} |`;
  }),
  "",
  "## Reproduction and limitations",
  "",
  "`yarn benchmark:row-memo` builds and measures this isolated experiment without overwriting the three-variant report. `yarn benchmark:all` also refreshes the main comparison with matching ablation evidence; CI publishes both together. Open report.html directly in a browser or follow its link from the hosted comparison.",
  "",
  `Source fingerprint: \`${input.sourceFingerprint}\`. Each build's arm, mode, React version and source fingerprint are checked before measurement and again during reporting. Raw order, blocks, paired samples, matched states and profiling actual/base records are in [measurements.json](measurements.json); computed summaries are in [comparison.json](comparison.json).`,
  "",
  "This fixed dataset and workflow do not cover real-user devices, first-load interactions, retained-cache memory or all possible application states. Repeated favorite toggles accumulate identical activity history in both arms; pairing controls that history, but later pairs need not have the same cost as earlier ones. Run independent sessions and choose a practical performance budget before drawing stronger conclusions.",
  "",
].join("\n");
writeFileSync(`${directory}/comparison.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${directory}/comparison.md`, markdown);
writeFileSync(
  `${directory}/report.html`,
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manual row memo ablation</title>
<style>body{max-width:1100px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif;color:#203032;background:#f6f8f8}table{display:block;overflow-x:auto;border-collapse:collapse;max-width:100%}th,td{padding:.6rem;border:1px solid #cbd5d8;text-align:left}th{background:#e5eeeb}code{overflow-wrap:anywhere}a{color:#006f62}</style></head>
<body>${marked.parse(markdown)}</body></html>\n`,
);
console.log(`Wrote ${directory}/comparison.json, comparison.md and report.html`);

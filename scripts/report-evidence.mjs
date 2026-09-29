import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { hashFiles } from "./benchmark-provenance.mjs";
import { analyzeRowAblation } from "./row-ablation.mjs";

export const ablationFiles = [
  "measurements.json",
  "comparison.json",
  "comparison.md",
  "report.html",
];

export function rowComparison(compiler, manual, baseline) {
  if (compiler === manual)
    return baseline > compiler
      ? `C = M; ${baseline - compiler} fewer row events than B`
      : "C = M on row events";
  return `${compiler < manual ? "C" : "M"} records fewer row events`;
}

export function evaluateComparison(report) {
  const { bytes, percent } = report.deltas.js.raw;
  const bundle =
    bytes === 0
      ? "compiler and manual ship the same amount of minified JavaScript."
      : `compiler ships ${Math.abs(percent).toFixed(2)}% ${bytes > 0 ? "more" : "less"} minified JavaScript.`;
  const compiler = report.interactions.selection.compiler;
  const manual = report.interactions.selection.manual;
  return {
    recommendation: `No demonstrated selection-speed winner between compiler and manual; ${bundle}`,
    rationale: `With 4x CPU slowdown, median selection-to-detail DOM was ${compiler.medianDomMs} ms (compiler) vs ${manual.medianDomMs} ms (manual), and two-frame paint opportunity was ${compiler.medianPaintMs} vs ${manual.medianPaintMs} ms. These descriptive timings do not establish a repeatable speed winner. Fewer row render-work events do not by themselves demonstrate lower latency.`,
    caveat: `Twenty warmed interactions in one Chromium process and three local load/Lighthouse repetitions are advisory, not statistical proof or real-user evidence. Paint opportunity is not a guaranteed presentation timestamp. Render-work events use internal React ${report.versions.react} profiling fiber flags, not a public API; revalidate after upgrades. The Oxc compiler integration is experimental.`,
  };
}

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

export function inspectRowCaching(compiler, manual) {
  const parse = (source) => {
    const result = ts.createSourceFile("App.js", source, ts.ScriptTarget.Latest, true);
    assert.equal(result.parseDiagnostics.length, 0, "Invalid compiled App snapshot");
    return result;
  };
  const compiled = parse(compiler);
  const handwritten = parse(manual);
  const component = (name) =>
    find(compiled, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const list = component("IncidentList");
  const row = component("IncidentRow");
  const listCache =
    list &&
    find(
      list,
      (node) =>
        ts.isIfStatement(node) &&
        /\$\[\d+\]/.test(node.expression.getText()) &&
        /\bincidents\b/.test(node.expression.getText()) &&
        /\bselectedId\b/.test(node.expression.getText()) &&
        node.thenStatement.getText().includes("incidents.map("),
    );
  const childCache =
    row &&
    find(
      row,
      (node) =>
        ts.isIfStatement(node) &&
        /\$\[\d+\]/.test(node.expression.getText()) &&
        node.thenStatement.getText().includes("_jsx(OpenIncidentButton,"),
    );
  const manualRow = find(
    handwritten,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "IncidentRow" &&
      node.initializer?.getText().includes("memo("),
  );
  if (!listCache || !childCache || !manualRow)
    return {
      status: "unrecognized",
      explanation:
        "Generated-code pattern changed: inspect the linked App snapshots before attributing the counts to the previously observed cache boundaries.",
    };
  return {
    status: "recognized",
    explanation:
      "In this Oxc output, IncidentList caches the whole mapped result against incidents and selectedId. Invalidating that cache runs the map again. IncidentRow also caches child JSX internally, while the manual outer memo boundary can skip entering an unchanged row. This is a difference in optimization boundaries, not a general inability of React Compiler to achieve memo-like bailouts through caller-side JSX caching.",
    excerpts: [
      { label: "Compiler: list-wide cache", code: listCache.getText() },
      { label: "Compiler: cached child JSX inside IncidentRow", code: childCache.getText() },
      {
        label: "Manual: outer row boundary (ordinary builds define the row-memo flag as true)",
        code: manualRow.parent.parent.getText(),
      },
    ],
  };
}

export function selectionEvidence(actions) {
  const selected = ["compiler", "manual", "baseline"].map((app) =>
    actions[app].find((action) => action.name === "select incident"),
  );
  assert.ok(selected.every(Boolean), "Selection evidence is missing");
  const [compiler, manual, baseline] = selected;
  const triplet = (field) => selected.map((sample) => sample[field]).join(" / ");
  const observedGap =
    compiler.rowRenders === baseline.rowRenders &&
    compiler.rowRenders > manual.rowRenders &&
    compiler.openButtonRenders < baseline.openButtonRenders;
  return [
    `For selection in this run (C / M / B), row events are **${triplet("rowRenders")}**, open-button events **${triplet("openButtonRenders")}**, and favorite-button events **${triplet("favoriteButtonRenders")}**.`,
    observedGap
      ? "Compiler and baseline record the same number of row events here, but the compiler records fewer child-button events. Equal row counts do not mean equal CPU cost or equal DOM work."
      : "This run does not show the previously observed combination of equal compiler/baseline row counts and fewer compiler child-button events. Use these current counts rather than assuming an older 67-row result still applies.",
  ].join(" ");
}

export function loadAblationEvidence(report, directory = "benchmark/results/row-memo") {
  const present = ablationFiles.filter((file) => existsSync(`${directory}/${file}`));
  if (!present.length)
    return {
      status: "unavailable",
      reason:
        "Ablation unavailable for this build: run yarn benchmark:row-memo, then regenerate the comparison with node scripts/report.mjs.",
    };
  assert.equal(
    present.length,
    ablationFiles.length,
    "Incomplete ablation artifacts; rerun yarn benchmark:row-memo",
  );
  const read = (name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
  const raw = read("measurements.json");
  const ablation = read("comparison.json");
  if (
    raw.sourceFingerprint !== report.provenance.sourceFingerprint ||
    ablation.sourceFingerprint !== raw.sourceFingerprint ||
    raw.browser !== report.versions.playwrightChromium ||
    raw.reactVersion !== report.versions.react
  )
    return {
      status: "unavailable",
      reason:
        "Ablation unavailable for this build: stored source or runtime provenance differs. Rerun yarn benchmark:row-memo and regenerate the comparison.",
    };
  const recomputed = analyzeRowAblation(raw);
  for (const [key, value] of Object.entries(recomputed))
    assert.deepEqual(ablation[key], value, `Ablation summary differs from raw evidence: ${key}`);
  assert.deepEqual(
    ablation.bundles.on,
    report.bundles.manual,
    "Ablation ON must match the measured manual bundle",
  );
  const expectedFiles = Object.fromEntries(
    Object.values(report.bundles.manual.files)
      .flat()
      .map((file) => [file, report.provenance.builds.manual.production[`./${file}`]]),
  );
  assert.deepEqual(
    ablation.productionFiles.on,
    expectedFiles,
    "Ablation ON bytes differ from the measured manual build",
  );
  for (const kind of ["js", "css", "total"]) {
    for (const encoding of ["raw", "gzip"]) {
      assert.ok(Number.isFinite(ablation.bundles.off[kind][encoding]));
      assert.equal(
        ablation.bundleDeltaOnMinusOff[kind][encoding],
        ablation.bundles.on[kind][encoding] - ablation.bundles.off[kind][encoding],
      );
    }
  }
  return {
    status: "available",
    sourceFingerprint: raw.sourceFingerprint,
    artifacts: hashFiles(directory, ablationFiles),
    profiling: ablation.profiling,
    timings: ablation.timings,
    bundleDeltaOnMinusOff: ablation.bundleDeltaOnMinusOff.total,
  };
}

export function ablationMarkdown(evidence) {
  const intro = [
    "## What the isolated row-memo experiment adds",
    "",
    "The three comparison arms remain unchanged. A separate manual-app experiment toggles only the outer IncidentRow memo wrapper; callbacks, provider values and child memoization stay intact. Removing that wrapper does not reproduce compiler caching inside the row, and cannot predict the benefit of adding memo to the compiler arm.",
    "",
  ];
  if (evidence.status !== "available") return [...intro, evidence.reason, ""];
  const ms = (value) => value.toFixed(2);
  const interval = (values) => values.map(ms).join(" to ");
  const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
  return [
    ...intro,
    "These results match the main report's source fingerprint and runtime versions; the ON arm's initial-load assets are byte-identical to the measured manual build. Timings are from a separate paired experiment, not extra trials pooled into the three-arm selection comparison.",
    "",
    "| Action | Row events ON / OFF | Mean paired DOM saving (ms) | 95% interval (ms) | Mean paired frame-opportunity saving (ms) | 95% interval (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...evidence.timings.map((action, index) => {
      const dom = action.dom.pairedSavingsMs;
      const frame = action.frameOpportunity.pairedSavingsMs;
      return `| ${action.name} | ${evidence.profiling.on[index].rowRenders} / ${evidence.profiling.off[index].rowRenders} | ${ms(dom.mean)} | ${interval(dom.blockMean95CI)} | ${ms(frame.mean)} | ${interval(frame.blockMean95CI)} |`;
    }),
    "",
    `Whole-build ON-minus-OFF bundle delta: **${signed(evidence.bundleDeltaOnMinusOff.raw)} raw bytes / ${signed(evidence.bundleDeltaOnMinusOff.gzip)} gzip bytes**. This is not the isolated library size of React.memo.`,
    "",
    "Positive savings are OFF minus ON, favoring memo. Thirty paired trials at 4x CPU throttle are grouped into three fresh-context blocks; exploratory Student-t intervals use the three block means, not 30 independent observations. All blocks share one browser/hardware session, and intervals are unadjusted across endpoints. Spanning zero is inconclusive, not equivalence. Frame opportunity is not actual paint; neither endpoint is INP. No automatic winner or timing gate is inferred.",
    "",
    "[Full row-memo report](row-memo/report.html) · [Paired raw measurements](row-memo/measurements.json) · [Computed ablation summaries](row-memo/comparison.json)",
    "",
  ];
}

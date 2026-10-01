import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { filteringProtocol, filteringResultIds } from "../benchmark/filtering.mjs";
import { loadMemoryOrders } from "../benchmark/load-memory.mjs";
import { hashFiles } from "./benchmark-provenance.mjs";
import { median } from "./profile-counts.mjs";
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
      ? "ships the same amount of minified JavaScript"
      : `ships ${Math.abs(percent).toFixed(2)}% ${bytes > 0 ? "more" : "less"} minified JavaScript`;
  const bundleConclusion =
    bytes > 0
      ? "Manual optimization has lower bundle cost in this workload."
      : bytes < 0
        ? "The compiler has lower bundle cost in this workload."
        : "Neither approach has a bundle-size advantage in this workload.";
  const labels = {
    baseline: "No memoization",
    manual: "Manual memoization",
    compiler: "React Compiler",
  };
  const selection = ["baseline", "manual", "compiler"]
    .map((app) => `${report.interactions.selection[app].medianDomMs} ms (${labels[app]})`)
    .join("; ");
  return {
    recommendation: `Manual memoization remains effective in this app: no demonstrated selection-speed winner between compiler and manual, while compiler ${bundle}.`,
    rationale: `${bundleConclusion} Median selection-to-detail DOM at 4x CPU slowdown: ${selection}. These descriptive timings do not establish a repeatable speed winner. They do not establish equivalent responsiveness, identical memory behavior, or guaranteed gains in every scenario. Compare load, selection and query filtering separately; fewer render-work events do not by themselves demonstrate lower latency.`,
    caveat: `Six local load repetitions, three Lighthouse audits and twenty warmed trials per interaction in one Chromium process are advisory, not statistical proof or real-user evidence. Paint opportunity is not a guaranteed presentation timestamp. Render-work events use internal React ${report.versions.react} profiling fiber flags, not a public API; revalidate after upgrades. The Oxc compiler integration is experimental.`,
  };
}

export function analyzeUplt(input) {
  assert.equal(input.cpuRate, 4, "UPLT must use 4x CPU slowdown");
  assert.equal(input.repetitions.length, loadMemoryOrders.length, "UPLT requires six repetitions");
  input.repetitions.forEach((repeat, index) => {
    assert.deepEqual(repeat.order, loadMemoryOrders[index], "UPLT requires all six app orders");
  });
  return Object.fromEntries(
    ["baseline", "manual", "compiler"].map((app) => {
      const samples = input.repetitions.map((repeat) => repeat[app].uptlMs);
      assert.ok(
        samples.every((value) => Number.isFinite(value) && value > 0),
        `${app} missing UPLT timing`,
      );
      return [
        app,
        {
          medianMs: Number(median(samples).toFixed(1)),
          samplesMs: samples.map((value) => Number(value.toFixed(1))),
        },
      ];
    }),
  );
}

export function analyzeFiltering(raw, browser) {
  assert.equal(raw?.schemaVersion, 1, "Missing filtering timing; rerun yarn benchmark");
  assert.equal(raw.browser, browser, "Filtering browser differs from profiling browser");
  assert.equal(raw.cpuRate, 4, "Filtering timing must use 4x CPU slowdown");
  assert.deepEqual(raw.protocol, filteringProtocol, "Filtering protocol changed");
  assert.equal(raw.repetitions.length, 20, "Filtering requires 20 repetitions");
  const apps = ["baseline", "manual", "compiler"];
  raw.repetitions.forEach((repeat, index) => {
    assert.deepEqual(
      [...repeat.order].sort(),
      [...apps].sort(),
      "Filtering app order is incomplete",
    );
    const first = raw.repetitions[0].order;
    assert.deepEqual(
      repeat.order,
      [...first.slice(index % 3), ...first.slice(0, index % 3)],
      "Filtering order must rotate",
    );
    for (const app of apps) {
      assert.equal(
        repeat[app].length,
        filteringProtocol.steps.length,
        "Filtering steps are incomplete",
      );
      repeat[app].forEach((sample, stepIndex) => {
        const step = filteringProtocol.steps[stepIndex];
        for (const [key, value] of Object.entries(step))
          assert.equal(sample[key], value, `Filtering ${app} ${key} differs`);
        assert.deepEqual(
          sample.resultIds,
          filteringResultIds(step.query),
          "Filtering result IDs differ",
        );
        assert.ok(
          Number.isFinite(sample.paintMs) && sample.paintMs > 0,
          "Filtering frame timing is missing",
        );
        if (step.resultsChanged) {
          assert.ok(
            Number.isFinite(sample.domMs) && sample.domMs > 0 && sample.paintMs >= sample.domMs,
            "Filtering DOM timing is missing",
          );
        } else assert.equal(sample.domMs, null, "Unchanged results have no result-DOM timing");
      });
    }
  });
  const rounded = (value) => Number(value.toFixed(1));
  const p90 = (values) =>
    [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.9) - 1];
  return {
    protocol: raw.protocol,
    cpuRate: raw.cpuRate,
    order: raw.repetitions.map((repeat) => repeat.order),
    apps: Object.fromEntries(
      apps.map((app) => [
        app,
        filteringProtocol.steps.map((step, index) => {
          const runs = raw.repetitions.map((repeat) => repeat[app][index]);
          const dom = runs.map((sample) => sample.domMs);
          const paint = runs.map((sample) => sample.paintMs);
          return {
            ...step,
            medianDomMs: step.resultsChanged ? rounded(median(dom)) : null,
            p90DomMs: step.resultsChanged ? rounded(p90(dom)) : null,
            medianPaintMs: rounded(median(paint)),
            p90PaintMs: rounded(p90(paint)),
            runs,
          };
        }),
      ]),
    ),
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
  const observedGap =
    compiler.rowRenders === baseline.rowRenders &&
    compiler.rowRenders > manual.rowRenders &&
    compiler.openButtonRenders < baseline.openButtonRenders;
  return [
    `Selection update events: **No memoization: ${baseline.rowRenders} rows, ${baseline.openButtonRenders} open buttons, ${baseline.favoriteButtonRenders} favorite buttons; Manual memoization: ${manual.rowRenders} rows, ${manual.openButtonRenders} open buttons, ${manual.favoriteButtonRenders} favorite buttons; React Compiler: ${compiler.rowRenders} rows, ${compiler.openButtonRenders} open buttons, ${compiler.favoriteButtonRenders} favorite buttons**.`,
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

export function ablationMarkdown(evidence, headingDepth = 2) {
  const intro = [
    `${"#".repeat(headingDepth)} What the isolated row-memo experiment adds`,
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

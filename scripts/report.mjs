import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { measureBundle } from "./bundle-size.mjs";
import { analyzeLoadMemory } from "./load-memory.mjs";
import { filteringProtocol, filteringResultIds } from "../benchmark/filtering.mjs";
import { renderComparison } from "./report-markdown.mjs";
import { comparisonBuilds, validateProvenance } from "./benchmark-provenance.mjs";
import {
  analyzeFiltering,
  analyzeUplt,
  evaluateComparison,
  inspectRowCaching,
  loadAblationEvidence,
} from "./report-evidence.mjs";
import {
  assertMeasurementsV2,
  countProfileRecords,
  median,
  summarizeProfileSamples,
  validateProfileRecords,
} from "./profile-counts.mjs";

const directory = "benchmark/results";
const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
assertMeasurementsV2(input);
const provenance = JSON.parse(readFileSync(`${directory}/provenance.json`, "utf8"));
validateProvenance(provenance, directory);
assert.deepEqual(
  comparisonBuilds(),
  provenance.builds,
  "Builds changed since measurement; rerun yarn benchmark",
);
const slowdown = JSON.parse(readFileSync(`${directory}/slowdown.json`, "utf8"));
const selectionLatency = JSON.parse(readFileSync(`${directory}/selection-latency.json`, "utf8"));
const filteringLatency = JSON.parse(readFileSync(`${directory}/filtering-latency.json`, "utf8"));
const audits = JSON.parse(readFileSync(`${directory}/lighthouse.json`, "utf8"));
const loadMemory = JSON.parse(readFileSync(`${directory}/load-memory.json`, "utf8"));
const packages = JSON.parse(readFileSync("package.json", "utf8"));
const apps = ["compiler", "manual", "baseline"];
const round = (value, digits = 1) => Number(value.toFixed(digits));
const p90 = (numbers) =>
  [...numbers].sort((left, right) => left - right)[Math.ceil(numbers.length * 0.9) - 1];

function flameChart(app) {
  const profile = JSON.parse(readFileSync(`${directory}/favorite-${app}.cpuprofile`, "utf8"));
  assert.ok(
    profile.samples?.length && profile.samples.length === profile.timeDeltas?.length,
    `${app} CPU profile needs timed samples`,
  );
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map(
    profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id])),
  );
  const total = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0);
  const activeJS = profile.samples.reduce((sum, id, index) => {
    const name = nodes.get(id)?.callFrame.functionName;
    return sum + (name === "(idle)" || name === "(program)" ? 0 : profile.timeDeltas[index]);
  }, 0);
  const rectangles = [];
  let active = [];
  let elapsed = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const stack = [];
    let nodeId = profile.samples[index];
    while (nodeId !== undefined) {
      stack.unshift(nodeId);
      nodeId = parents.get(nodeId);
    }
    let common = 0;
    while (common < active.length && active[common].id === stack[common]) common++;
    rectangles.push(...active.splice(common).map((bar) => ({ ...bar, end: elapsed })));
    for (const id of stack.slice(common)) active.push({ id, start: elapsed, depth: active.length });
    elapsed += profile.timeDeltas[index];
  }
  rectangles.push(...active.map((bar) => ({ ...bar, end: elapsed })));
  const escape = (text) =>
    String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const height = 48 + (1 + Math.max(...rectangles.map((bar) => bar.depth))) * 19;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${height}" role="img" aria-label="${app} favorite action CPU flame chart at 4x slowdown">`,
    '<rect width="1000" height="100%" fill="#f6f8f8"/>',
    `<text x="8" y="19" font-family="sans-serif" font-size="12" fill="#202b32">${app} / favorite incident / 4x CPU / ${round(total / 1000)} ms sampled window</text>`,
  ];
  for (const bar of rectangles) {
    const node = nodes.get(bar.id);
    const name = node?.callFrame.functionName || "(anonymous)";
    const x = (1000 * bar.start) / total;
    const width = (1000 * (bar.end - bar.start)) / total;
    const hue =
      ((Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0) * 37) % 180) + 18;
    const label = `${name} (${node?.callFrame.url || "browser"}:${node?.callFrame.lineNumber ?? 0})`;
    svg.push(
      `<g><title>${escape(label)}</title><rect x="${round(x, 2)}" y="${30 + bar.depth * 19}" width="${round(width, 2)}" height="18" fill="hsl(${hue} 48% 71%)" stroke="#f6f8f8" stroke-width=".5"/>${width > 55 ? `<text x="${round(x + 3, 2)}" y="${43 + bar.depth * 19}" font-family="sans-serif" font-size="10" fill="#203032">${escape(name.slice(0, Math.floor(width / 6)))}</text>` : ""}</g>`,
    );
  }
  svg.push("</svg>");
  writeFileSync(`${directory}/favorite-${app}.svg`, svg.join("\n"));
  return {
    samples: profile.samples.length,
    sampledMs: round(total / 1000),
    activeJsMs: round(activeJS / 1000),
    activeSharePercent: round((activeJS * 100) / total),
    profile: `favorite-${app}.cpuprofile`,
    chart: `favorite-${app}.svg`,
  };
}

const report = {
  schemaVersion: 2,
  provenance,
  versions: {
    node: process.version,
    playwrightChromium: input.browser,
    react: packages.devDependencies.react,
    vite: packages.devDependencies.vite,
    pluginReact: packages.devDependencies["@vitejs/plugin-react"],
    oxcTransformReact: packages.devDependencies["oxc-transform-react"],
    oxlint: packages.devDependencies.oxlint,
    lighthouse: audits.repetitions[0].compiler.version,
  },
  workload:
    "200 deterministic incidents; isolated Chromium contexts; one warm-up and 3 rotated profiling repetitions; 6 UPLT runs covering all app orders; initial mounts outside actions, action mounts reported separately from updates",
  bundles: Object.fromEntries(apps.map((app) => [app, measureBundle(`apps/${app}/dist`)])),
  actions: {},
  load: analyzeUplt(slowdown),
  interactions: { selection: {}, filtering: analyzeFiltering(filteringLatency, input.browser) },
  paths: { filtering: {} },
  memory: {},
  loadMemory: analyzeLoadMemory(loadMemory, input.browser),
  lighthouse: {},
  cpu: {},
};
assert.equal(input.repetitions.length, 3, "Profiling requires three repetitions");
for (const app of apps) {
  const runs = input.repetitions.map((repeat) => repeat[app]);
  assert.ok(
    runs.every((run) => run.mounts > 0),
    `${app} recorder did not capture mounts`,
  );
  for (const run of runs) {
    assert.deepEqual(
      run.actions.map((action) => action.name),
      runs[0].actions.map((action) => action.name),
      `${app} action names/order differ across repetitions`,
    );
    validateProfileRecords(run.actions.flatMap((action) => action.records));
  }
  report.actions[app] = runs[0].actions.map((action, index) => {
    const samples = runs.map((run) =>
      countProfileRecords(run.actions[index].records, run.actions[index].fiberRenders),
    );
    return {
      name: action.name,
      ...summarizeProfileSamples(samples),
    };
  });
  for (const run of runs) {
    const path = run.paths?.filtering;
    assert.ok(path?.mounts > 0, `${app} missing isolated filtering profile; rerun yarn benchmark`);
    assert.deepEqual(path.initialState, filteringProtocol.initialState);
    assert.equal(path.actions.length, filteringProtocol.steps.length);
    validateProfileRecords(path.actions.flatMap((action) => action.records));
    path.actions.forEach((sample, index) => {
      const step = filteringProtocol.steps[index];
      for (const [key, value] of Object.entries(step)) assert.equal(sample[key], value);
      assert.deepEqual(sample.resultIds, filteringResultIds(step.query));
      const counts = countProfileRecords(sample.records, sample.fiberRenders);
      assert.ok(counts.commits > 0, "Filtering input must have a completed profiling commit");
      assert.equal(counts.mounts.rows, step.query === "" ? 166 : 0);
    });
  }
  report.paths.filtering[app] = filteringProtocol.steps.map((step, index) => ({
    ...step,
    ...summarizeProfileSamples(
      runs.map((run) => {
        const sample = run.paths.filtering.actions[index];
        return countProfileRecords(sample.records, sample.fiberRenders);
      }),
    ),
  }));
}
assert.equal(slowdown.cpuRate, 4, "UPLT and CPU traces must use a 4x CPU slowdown");
assert.equal(selectionLatency.cpuRate, 4, "Selection timing must use a 4x CPU slowdown");
assert.equal(selectionLatency.repetitions.length, 20, "Selection timing requires 20 repetitions");
assert.equal(audits.repetitions.length, 3);
for (const app of apps) {
  const selectionRuns = selectionLatency.repetitions.map((repeat) => repeat[app]);
  assert.ok(
    selectionRuns.every((sample) => sample.domMs > 0 && sample.paintMs >= sample.domMs),
    `${app} missing selection timing`,
  );
  const domTimes = selectionRuns.map((sample) => sample.domMs);
  const paintTimes = selectionRuns.map((sample) => sample.paintMs);
  report.interactions.selection[app] = {
    medianDomMs: round(median(domTimes)),
    p90DomMs: round(p90(domTimes)),
    medianPaintMs: round(median(paintTimes)),
    p90PaintMs: round(p90(paintTimes)),
    runs: selectionRuns,
  };
  const heapSamples = slowdown.repetitions.map((repeat) => {
    const { heapBeforeBytes: beforeBytes, heapAfterBytes: afterBytes } = repeat[app];
    assert.ok(beforeBytes > 0 && afterBytes > 0, `${app} missing JS heap snapshots`);
    return { beforeBytes, afterBytes, deltaBytes: afterBytes - beforeBytes };
  });
  report.memory[app] = {
    beforeBytes: median(heapSamples.map((sample) => sample.beforeBytes)),
    afterBytes: median(heapSamples.map((sample) => sample.afterBytes)),
    deltaBytes: median(heapSamples.map((sample) => sample.deltaBytes)),
    runs: heapSamples,
  };
  const samples = audits.repetitions.map((repeat) => repeat[app]);
  const metrics = [
    "performanceScore",
    "accessibilityScore",
    "fcpMs",
    "lcpMs",
    "tbtMs",
    "speedIndexMs",
    "cls",
    "interactiveMs",
  ];
  report.lighthouse[app] = Object.fromEntries(
    metrics.map((key) => {
      const values = samples.map((sample) => sample[key]);
      assert.ok(
        values.every((value) => typeof value === "number" && Number.isFinite(value)),
        `${app} Lighthouse ${key} missing`,
      );
      return [key, round(median(values), key === "cls" ? 3 : 1)];
    }),
  );
  report.lighthouse[app].runs = samples.map((sample) =>
    Object.fromEntries(metrics.map((key) => [key, sample[key]])),
  );
  report.cpu[app] = flameChart(app);
}
report.lighthouse.settings = {
  formFactor: audits.repetitions[0].compiler.settings.formFactor,
  throttlingMethod: audits.repetitions[0].compiler.settings.throttlingMethod,
};

function delta(kind, encoding) {
  const compiler = report.bundles.compiler[kind][encoding];
  const manual = report.bundles.manual[kind][encoding];
  return {
    bytes: compiler - manual,
    percent: Number((((compiler - manual) * 100) / manual).toFixed(2)),
  };
}
report.deltas = Object.fromEntries(
  ["js", "css", "total"].map((kind) => [
    kind,
    { raw: delta(kind, "raw"), gzip: delta(kind, "gzip") },
  ]),
);
report.baselineDeltas = Object.fromEntries(
  ["compiler", "manual"].map((app) => [
    app,
    Object.fromEntries(
      ["js", "css", "total"].map((kind) => [
        kind,
        Object.fromEntries(
          ["raw", "gzip"].map((encoding) => {
            const bytes =
              report.bundles[app][kind][encoding] - report.bundles.baseline[kind][encoding];
            return [
              encoding,
              {
                bytes,
                percent: round((bytes * 100) / report.bundles.baseline[kind][encoding], 2),
              },
            ];
          }),
        ),
      ]),
    ),
  ]),
);
report.evaluation = evaluateComparison(report);
mkdirSync(`${directory}/sources`, { recursive: true });
for (const app of ["compiler", "manual"])
  cpSync(`apps/${app}/dist/sources/App.js`, `${directory}/sources/${app}-App.js`);
report.rowCaching = inspectRowCaching(
  readFileSync(`${directory}/sources/compiler-App.js`, "utf8"),
  readFileSync(`${directory}/sources/manual-App.js`, "utf8"),
);
report.rowMemo = loadAblationEvidence(report);
if (process.argv.includes("--require-ablation"))
  assert.equal(report.rowMemo.status, "available", report.rowMemo.reason);
if (report.rowMemo.status !== "available") console.warn(report.rowMemo.reason);
writeFileSync(`${directory}/comparison.json`, JSON.stringify(report, null, 2));

writeFileSync(`${directory}/comparison.md`, renderComparison(report));
console.log(`Wrote ${directory}/comparison.json and comparison.md`);

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { strict as assert } from "node:assert";

const directory = "benchmark/results";
const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
const slowdown = JSON.parse(readFileSync(`${directory}/slowdown.json`, "utf8"));
const audits = JSON.parse(readFileSync(`${directory}/lighthouse.json`, "utf8"));
const packages = JSON.parse(readFileSync("package.json", "utf8"));
const apps = ["compiler", "manual", "baseline"];
const median = (numbers) => {
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 1) => Number(value.toFixed(digits));

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
    profile: `favorite-${app}.cpuprofile`,
    chart: `favorite-${app}.svg`,
  };
}

function bundle(app) {
  const directory = `apps/${app}/dist`;
  const manifest = JSON.parse(readFileSync(`${directory}/.vite/manifest.json`, "utf8"));
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  assert.ok(entry, `${app} is missing an entry chunk`);
  const visited = new Set();
  const files = { js: new Set(), css: new Set() };
  const loadedLater = new Set();
  function visit(chunk) {
    if (visited.has(chunk)) return;
    visited.add(chunk);
    const item = manifest[chunk];
    assert.ok(item, `${app} is missing manifest chunk ${chunk}`);
    if (item.file.endsWith(".js")) files.js.add(item.file);
    for (const css of item.css ?? []) files.css.add(css);
    for (const dependency of item.imports ?? []) visit(dependency);
    for (const dependency of item.dynamicImports ?? []) loadedLater.add(dependency);
  }
  visit(Object.keys(manifest).find((key) => manifest[key] === entry));
  function sizes(paths) {
    return [...paths].reduce(
      (total, path) => {
        const bytes = readFileSync(`${directory}/${path}`);
        total.raw += bytes.length;
        total.gzip += gzipSync(bytes).length;
        return total;
      },
      { raw: 0, gzip: 0 },
    );
  }
  const js = sizes(files.js);
  const css = sizes(files.css);
  assert.ok(js.raw > 0 && css.raw > 0, `${app} needs nonzero entry JS and CSS`);
  return {
    js,
    css,
    total: { raw: js.raw + css.raw, gzip: js.gzip + css.gzip },
    files: { js: [...files.js], css: [...files.css] },
    loadedLater: [...loadedLater],
  };
}

function counts(records) {
  const updates = records.filter((record) => record.phase !== "mount");
  const byId = (id) => updates.filter((record) => record.id === id);
  const rows = updates.filter((record) => record.id.startsWith("row:"));
  const openButtons = updates.filter((record) => record.id.startsWith("button:open:"));
  const favoriteButtons = updates.filter((record) => record.id.startsWith("button:favorite:"));
  const durations = (entries) =>
    entries.length ? median(entries.map((entry) => entry.actualDuration)) : null;
  return {
    commits: new Set(updates.map((record) => record.commitTime)).size,
    shell: byId("shell").length,
    list: byId("list").length,
    detail: byId("detail").length,
    rows: rows.length,
    openButtons: openButtons.length,
    favoriteButtons: favoriteButtons.length,
    affectedRows: [...new Set(rows.map((record) => record.id.slice(4)))].sort(),
    durationMs: {
      shell: durations(byId("shell")),
      list: durations(byId("list")),
      detail: durations(byId("detail")),
      rows: durations(rows),
    },
  };
}

const report = {
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
    "200 deterministic incidents; isolated Chromium contexts; one warm-up; 3 repetitions alternating app order; mounts excluded from updates",
  bundles: Object.fromEntries(apps.map((app) => [app, bundle(app)])),
  actions: {},
  load: {},
  lighthouse: {},
  cpu: {},
};
for (const app of apps) {
  const runs = input.repetitions.map((repeat) => repeat[app]);
  assert.ok(
    runs.every((run) => run.mounts > 0),
    `${app} recorder did not capture mounts`,
  );
  report.actions[app] = runs[0].actions.map((action, index) => {
    const samples = runs.map((run) => counts(run.actions[index].records));
    return {
      name: action.name,
      ...Object.fromEntries(
        ["commits", "shell", "list", "detail", "rows", "openButtons", "favoriteButtons"].map(
          (key) => [key, median(samples.map((sample) => sample[key]))],
        ),
      ),
      affectedRows: [...new Set(samples.flatMap((sample) => sample.affectedRows))].sort(),
      medianDurationMs: Object.fromEntries(
        ["shell", "list", "detail", "rows"].map((key) => [
          key,
          median(
            samples.map((sample) => sample.durationMs[key]).filter((value) => value !== null),
          ) ?? null,
        ]),
      ),
      runs: samples,
    };
  });
}
assert.equal(slowdown.cpuRate, 4, "UPLT and CPU traces must use a 4x CPU slowdown");
assert.equal(slowdown.repetitions.length, 3);
assert.equal(audits.repetitions.length, 3);
for (const app of apps) {
  const loadSamples = slowdown.repetitions.map((repeat) => repeat[app].uptlMs);
  assert.ok(loadSamples.every((value) => value > 0));
  report.load[app] = {
    medianMs: round(median(loadSamples)),
    samplesMs: loadSamples.map((value) => round(value)),
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
const fewerUpdates = report.actions.compiler.some(
  (action, index) =>
    action.rows < report.actions.manual[index].rows ||
    action.commits < report.actions.manual[index].commits,
);
const moreUpdates = report.actions.compiler.some(
  (action, index) =>
    action.rows > report.actions.manual[index].rows ||
    action.commits > report.actions.manual[index].commits,
);
const largerBundle = report.deltas.total.gzip.bytes > 0;
const selectedRows = Object.fromEntries(
  apps.map((app) => [
    app,
    report.actions[app].find((action) => action.name === "select incident").rows,
  ]),
);
report.evaluation = {
  recommendation:
    !fewerUpdates && largerBundle
      ? "Keep manual memoization for this performance-first, already optimized app; do not enable the experimental compiler solely for speed."
      : fewerUpdates && !moreUpdates && !largerBundle
        ? "Compiler enablement looks worthwhile for this measured workload; validate on representative production devices before rollout."
        : "Mixed results: choose based on maintenance cost, byte budget, and repeatable real-user measurements.",
  rationale: `Selection updates ${selectedRows.baseline} rows without optimization vs ${selectedRows.compiler} with the compiler and ${selectedRows.manual} with manual memoization. Compiler vs manual: ${report.deltas.total.gzip.bytes >= 0 ? "+" : ""}${report.deltas.total.gzip.bytes} gzip bytes; median 4x-CPU UPLT ${report.load.compiler.medianMs} vs ${report.load.manual.medianMs} ms; Lighthouse performance ${report.lighthouse.compiler.performanceScore} vs ${report.lighthouse.manual.performanceScore}; ${fewerUpdates ? "some compiler actions commit fewer updates" : "no compiler action commits fewer rows or whole-app updates"}.`,
  caveat:
    "Three local repetitions and simulated Lighthouse scores are diagnostic, not statistical proof or real-user evidence. Compiler inference can reduce manual memo maintenance; its Oxc integration is experimental.",
};
writeFileSync(`${directory}/comparison.json`, JSON.stringify(report, null, 2));

const lines = [
  "# React Compiler / manual memoization / no optimization",
  "",
  `Node ${report.versions.node}; Chromium ${input.browser}; React ${report.versions.react}; Vite ${report.versions.vite}; plugin-react ${report.versions.pluginReact}; oxc-transform-react ${report.versions.oxcTransformReact}; Oxlint ${report.versions.oxlint}.`,
  "",
  report.workload,
  "",
  "## Evaluation",
  "",
  `**${report.evaluation.recommendation}**`,
  "",
  report.evaluation.rationale,
  "",
  report.evaluation.caveat,
  "",
  "## Initial-load production bytes",
  "",
  "| Asset | Compiler raw / gzip | Manual raw / gzip | Baseline raw / gzip | Delta raw / gzip (compiler - manual) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...["js", "css", "total"].map(
    (kind) =>
      `| ${kind.toUpperCase()} | ${report.bundles.compiler[kind].raw} / ${report.bundles.compiler[kind].gzip} | ${report.bundles.manual[kind].raw} / ${report.bundles.manual[kind].gzip} | ${report.bundles.baseline[kind].raw} / ${report.bundles.baseline[kind].gzip} | ${report.deltas[kind].raw.bytes} (${report.deltas[kind].raw.percent}%) / ${report.deltas[kind].gzip.bytes} (${report.deltas[kind].gzip.percent}%) |`,
  ),
  "",
  `Gzip delta vs baseline: compiler ${report.baselineDeltas.compiler.total.gzip.bytes} bytes (${report.baselineDeltas.compiler.total.gzip.percent}%); manual ${report.baselineDeltas.manual.total.gzip.bytes} bytes (${report.baselineDeltas.manual.total.gzip.percent}%).`,
  "",
  "Manifest entry JS, static imports, and attached CSS counted once per file. Source maps, dynamic imports, and profile builds excluded.",
  `Separately loaded chunks: ${apps.map((app) => `${app} ${report.bundles[app].loadedLater.join(", ") || "none"}`).join("; ")}.`,
  "",
  "## User-perceived load time (UPLT)",
  "",
  "UPLT is navigation start to the full 200-row incident table completing two animation frames (a paint opportunity). Fresh isolated contexts, normal production builds, 4x CDP CPU slowdown, three runs alternating order; no network throttling. This is a lab proxy for user-perceived readiness, not a Core Web Vital or an input-response metric.",
  "",
  "| App | Median UPLT (ms) | Run 1 / 2 / 3 (ms) |",
  "| --- | ---: | --- |",
  ...apps.map(
    (app) =>
      `| ${app} | ${report.load[app].medianMs} | ${report.load[app].samplesMs.join(" / ")} |`,
  ),
  "",
  "## Lighthouse (mobile lab)",
  "",
  `Lighthouse ${report.versions.lighthouse}, ${report.lighthouse.settings.formFactor} preset with ${report.lighthouse.settings.throttlingMethod} throttling, normal builds. Three fresh Chrome launches per app, alternating order. Scores are 0-100; remaining timings are milliseconds and CLS is unitless. Median metrics are advisory and do not share the 4x CDP setup above. ${apps.map((app) => `[${app} raw audit](lighthouse-${app}.json)`).join(" / ")}.`,
  "",
  "| Metric | Compiler | Manual | Baseline | Delta (compiler - manual) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...[
    ["Performance score", "performanceScore"],
    ["Accessibility score", "accessibilityScore"],
    ["FCP (ms)", "fcpMs"],
    ["LCP (ms)", "lcpMs"],
    ["TBT (ms)", "tbtMs"],
    ["Speed Index (ms)", "speedIndexMs"],
    ["CLS", "cls"],
    ["Time to Interactive (ms)", "interactiveMs"],
  ].map(
    ([label, key]) =>
      `| ${label} | ${report.lighthouse.compiler[key]} | ${report.lighthouse.manual[key]} | ${report.lighthouse.baseline[key]} | ${round(report.lighthouse.compiler[key] - report.lighthouse.manual[key], key === "cls" ? 3 : 1)} |`,
  ),
  "",
  "## CPU slowdown flame charts",
  "",
  "Normal-build favorite interaction at 4x CDP CPU slowdown; each flame chart spans its own sampled window. Horizontal width is sampled time, stack depth is vertical, and hover reveals function/source. Separate runs mean widths and colors are not directly comparable as a benchmark score. Idle/browser frames and Playwright-triggered work may be present; use the raw profiles in Chrome DevTools for investigation.",
  "",
  ...apps.flatMap((app) => [
    `### ${app} (${report.cpu[app].samples} samples / ${report.cpu[app].sampledMs} ms sampled)`,
    "",
    `![${app} CPU flame chart](${report.cpu[app].chart})`,
    "",
    `[Open raw ${app} CPU profile](${report.cpu[app].profile})`,
    "",
  ]),
  "## Committed subtree updates (median of 3 runs)",
  "",
  "| App / action | Unique app commits | Shell | List | Detail | Rows | Open buttons | Favorite buttons | Affected row IDs |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ...apps.flatMap((app) =>
    report.actions[app].map((action) => {
      const ids = action.affectedRows;
      const displayed =
        ids.length > 6
          ? `${ids.slice(0, 6).join(", ")} ... (${ids.length} IDs; full list in JSON)`
          : ids.join(", ") || "-";
      return `| ${app} / ${action.name} | ${action.commits} | ${action.shell} | ${action.list} | ${action.detail} | ${action.rows} | ${action.openButtons} | ${action.favoriteButtons} | ${displayed} |`;
    }),
  ),
  "",
  "Nested Profiler callbacks are grouped by commitTime for whole-app commits; shell, row and button subtree counts are separate and must not be added together. Mounts are excluded. Counts are committed updates, not component function calls or speculative renders. Similar counts are a valid result.",
  "Median actualDuration values (ms) are advisory, include profiling overhead, and are available per action and subtree in comparison.json; never used as CI thresholds. CPU profiles from benchmark:trace are separate browser sampling diagnostics.",
  "",
];
writeFileSync(`${directory}/comparison.md`, lines.join("\n"));
console.log(`Wrote ${directory}/comparison.json and comparison.md`);

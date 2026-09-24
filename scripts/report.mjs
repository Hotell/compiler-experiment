import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { strict as assert } from "node:assert";

const directory = "benchmark/results";
const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
const slowdown = JSON.parse(readFileSync(`${directory}/slowdown.json`, "utf8"));
const selectionLatency = JSON.parse(readFileSync(`${directory}/selection-latency.json`, "utf8"));
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
const p90 = (numbers) =>
  [...numbers].sort((left, right) => left - right)[Math.ceil(numbers.length * 0.9) - 1];
const kB = (bytes) => (bytes / 1000).toFixed(2);
const signedKB = (bytes) => `${bytes > 0 ? "+" : ""}${kB(bytes)}`;
const MiB = (bytes) => (bytes / 1048576).toFixed(2);

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

function counts(records, fiberRenders) {
  assert.ok(Array.isArray(fiberRenders), "Missing React fiber component-work records");
  const updates = records.filter((record) => record.phase !== "mount");
  const byId = (id) => updates.filter((record) => record.id === id);
  const rows = updates.filter((record) => record.id.startsWith("row:"));
  const queueItems = updates.filter((record) => record.id.startsWith("queue:"));
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
    rowRenders: fiberRenders.filter((id) => id.startsWith("row:")).length,
    queueRenders: fiberRenders.filter((id) => id.startsWith("queue:")).length,
    openButtonRenders: fiberRenders.filter((id) => id.startsWith("button:open:")).length,
    favoriteButtonRenders: fiberRenders.filter((id) => id.startsWith("button:favorite:")).length,
    queueItems: queueItems.length,
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
  interactions: { selection: {} },
  memory: {},
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
    const samples = runs.map((run) =>
      counts(run.actions[index].records, run.actions[index].fiberRenders),
    );
    return {
      name: action.name,
      ...Object.fromEntries(
        [
          "commits",
          "shell",
          "list",
          "detail",
          "rows",
          "rowRenders",
          "queueRenders",
          "openButtonRenders",
          "favoriteButtonRenders",
          "queueItems",
          "openButtons",
          "favoriteButtons",
        ].map((key) => [key, median(samples.map((sample) => sample[key]))]),
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
  const loadSamples = slowdown.repetitions.map((repeat) => repeat[app].uptlMs);
  assert.ok(loadSamples.every((value) => value > 0));
  report.load[app] = {
    medianMs: round(median(loadSamples)),
    samplesMs: loadSamples.map((value) => round(value)),
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
const selectedRows = Object.fromEntries(
  apps.map((app) => [
    app,
    report.actions[app].find((action) => action.name === "select incident").rowRenders,
  ]),
);
report.evaluation = {
  recommendation:
    "No demonstrated selection-speed winner between compiler and manual; manual ships the smaller bundle.",
  rationale: `With 4x CPU slowdown, median selection-to-detail DOM was ${report.interactions.selection.compiler.medianDomMs} ms (compiler) vs ${report.interactions.selection.manual.medianDomMs} ms (manual), and two-frame paint opportunity was ${report.interactions.selection.compiler.medianPaintMs} vs ${report.interactions.selection.manual.medianPaintMs} ms. Compiler vs manual bundle: ${signedKB(report.deltas.total.gzip.bytes)} kB gzip. The fiber diagnostic marks ${selectedRows.compiler} vs ${selectedRows.manual} row components during selection, but that does not quantify their cached work or establish latency.`,
  caveat: `Twenty warmed interactions in one Chromium process and three local load/Lighthouse repetitions are advisory, not statistical proof or real-user evidence. Paint opportunity is not a guaranteed presentation timestamp. Component work uses internal React ${report.versions.react} profiling fiber flags, not a public API; revalidate after upgrades. The Oxc compiler integration is experimental.`,
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
  "All sizes use decimal kB (1 kB = 1,000 bytes); exact bytes remain in comparison.json.",
  "",
  "| Asset | Compiler raw / gzip (kB) | Manual raw / gzip (kB) | Baseline raw / gzip (kB) | Delta raw / gzip (kB, compiler - manual) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...["js", "css", "total"].map(
    (kind) =>
      `| ${kind.toUpperCase()} | ${kB(report.bundles.compiler[kind].raw)} / ${kB(report.bundles.compiler[kind].gzip)} | ${kB(report.bundles.manual[kind].raw)} / ${kB(report.bundles.manual[kind].gzip)} | ${kB(report.bundles.baseline[kind].raw)} / ${kB(report.bundles.baseline[kind].gzip)} | ${signedKB(report.deltas[kind].raw.bytes)} (${report.deltas[kind].raw.percent}%) / ${signedKB(report.deltas[kind].gzip.bytes)} (${report.deltas[kind].gzip.percent}%) |`,
  ),
  "",
  `Gzip delta vs baseline: compiler ${signedKB(report.baselineDeltas.compiler.total.gzip.bytes)} kB (${report.baselineDeltas.compiler.total.gzip.percent}%); manual ${signedKB(report.baselineDeltas.manual.total.gzip.bytes)} kB (${report.baselineDeltas.manual.total.gzip.percent}%).`,
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
  "## Selection responsiveness (normal production builds)",
  "",
  "Select INC-0001 from Platform after one warm-up; 20 open/close trials per app in isolated contexts with app order rotated each trial and 4x CDP CPU slowdown. Browser timing starts in the click handler and stops at the detail DOM mutation; the two-frame measurement is a paint opportunity, not a guaranteed painted frame. Playwright action latency and React profiling overhead are excluded. Differences of a few milliseconds are advisory, not CI gates; individual samples are in comparison.json.",
  "",
  "| App | Detail DOM median (ms) | Detail DOM p90 (ms) | Paint opportunity median (ms) | Paint opportunity p90 (ms) |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...apps.map((app) => {
    const timing = report.interactions.selection[app];
    return `| ${app} | ${timing.medianDomMs} | ${timing.p90DomMs} | ${timing.medianPaintMs} | ${timing.p90PaintMs} |`;
  }),
  "",
  "## Post-GC JS heap (normal build)",
  "",
  "Fresh Chromium contexts under 4x CPU slowdown. CDP Performance.JSHeapUsedSize is sampled after forced GC once after the table is ready and again after favoriting INC-0001; GC runs outside the UPLT and CPU-profile windows. Values are medians of three paired runs. This is renderer JavaScript heap, **not** DOM/native memory, total tab memory, or a leak test. Full per-run bytes are in comparison.json.",
  "",
  "| App | Before favorite (MiB) | After favorite (MiB) | Median change (KiB) |",
  "| --- | ---: | ---: | ---: |",
  ...apps.map(
    (app) =>
      `| ${app} | ${MiB(report.memory[app].beforeBytes)} | ${MiB(report.memory[app].afterBytes)} | ${round(report.memory[app].deltaBytes / 1024)} |`,
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
  "One normal-build favorite-interaction trace per app at 4x CDP CPU slowdown. JS-active sampled time excludes V8 (idle) and (program) samples; it is an approximate slice of each trace window, **not** end-to-end interaction latency or a React render count. These separate single traces include Playwright-triggered work and cannot establish a performance winner.",
  "",
  "| App | Sampled window (ms) | JS-active sampled time (ms) | JS-active share |",
  "| --- | ---: | ---: | ---: |",
  ...apps.map(
    (app) =>
      `| ${app} | ${report.cpu[app].sampledMs} | ${report.cpu[app].activeJsMs} | ${report.cpu[app].activeSharePercent}% |`,
  ),
  "",
  `In this one capture, ${[...apps].sort((left, right) => report.cpu[left].activeJsMs - report.cpu[right].activeJsMs)[0]} had the fewest JS-active sampled milliseconds; single CPU traces are too noisy to establish a repeatable winner.`,
  "",
  "The flame charts below show stack depth vertically and sampled time horizontally; hover for function/source. Each chart has its own time scale. Use the raw profiles in Chrome DevTools to investigate hotspots, not to compare chart widths directly.",
  "",
  ...apps.flatMap((app) => [
    `### ${app} (${report.cpu[app].samples} samples / ${report.cpu[app].sampledMs} ms sampled)`,
    "",
    `![${app} CPU flame chart](${report.cpu[app].chart})`,
    "",
    `[Open raw ${app} CPU profile](${report.cpu[app].profile})`,
    "",
  ]),
  "## Component work and committed updates (median of 3 runs)",
  "",
  `C = compiler; M = manual; B = baseline. Row/queue/button columns count mounted-already components whose React ${report.versions.react} profiling fiber has the PerformedWork flag in a commit (a version-specific DevTools-like diagnostic). Only the whole-app commits column comes from React \`<Profiler>\` callbacks. Nested Profiler subtree callback counts remain separately in comparison.json: a callback does **not** prove its wrapped component function ran. Fewer component-work entries mean less render work, **not** necessarily lower latency. These are not additive counts or an API guaranteed across React releases.`,
  "",
  "| Action | Whole-app commits (C / M / B) | Queue component work (C / M / B) | Row component work (C / M / B) | Open button work (C / M / B) | Favorite button work (C / M / B) | Row comparison |",
  "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ...report.actions.compiler.map((action, index) => {
    const [compiler, manual, baseline] = apps.map((app) => report.actions[app][index]);
    assert.ok(apps.every((app) => report.actions[app][index].name === action.name));
    const triplet = (key) => `${compiler[key]} / ${manual[key]} / ${baseline[key]}`;
    const comparison =
      compiler.rowRenders === manual.rowRenders
        ? baseline.rowRenders > compiler.rowRenders
          ? `C = M; ${baseline.rowRenders - compiler.rowRenders} fewer rows than B`
          : "Tie on row work"
        : `${compiler.rowRenders < manual.rowRenders ? "C" : "M"} does less row work`;
    return `| ${action.name} | ${triplet("commits")} | ${triplet("queueRenders")} | ${triplet("rowRenders")} | ${triplet("openButtonRenders")} | ${triplet("favoriteButtonRenders")} | ${comparison} |`;
  }),
  "",
  "On queue switch, only the previously and newly selected queue items need to do work; the fiber diagnostic shows whether other queue item components also ran.",
  "",
  `Whole-app commits group nested React \`<Profiler>\` callbacks by commitTime. Component-work counts instead use React ${report.versions.react}'s internal PerformedWork fiber flag and exclude mounts, including rows reappearing after a filter reset. They can differ from subtree callback counts; neither measure captures aborted renders or guarantees user-visible speedups.`,
  "Median actualDuration values (ms) are advisory, include profiling overhead, and are available per action and subtree in comparison.json; never used as CI thresholds. CPU profiles from benchmark:trace are separate browser sampling diagnostics.",
  "",
];
writeFileSync(`${directory}/comparison.md`, lines.join("\n"));
console.log(`Wrote ${directory}/comparison.json and comparison.md`);

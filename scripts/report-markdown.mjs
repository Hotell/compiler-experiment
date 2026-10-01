import { loadMemoryMarkdown } from "./load-memory.mjs";
import { ablationMarkdown, selectionEvidence } from "./report-evidence.mjs";

export const reportSections = [
  { id: "overview", title: "Overview" },
  { id: "page-load", title: "Page load" },
  { id: "row-selection", title: "Row selection" },
  { id: "query-filtering", title: "Query filtering" },
  { id: "evidence", title: "Additional evidence" },
  { id: "methodology", title: "Methodology" },
];
const apps = ["baseline", "manual", "compiler"];
const labels = {
  baseline: "No memoization",
  manual: "Manual memoization",
  compiler: "React Compiler",
};
const values = (get) => Object.fromEntries(apps.map((app) => [app, get(app)]));
const signed = (value, digits) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

export function comparisonTable(rows) {
  return [
    "| Metric | No memoization | Manual memoization | React Compiler |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(({ label, values: cells, decimals = 1, relative = false }) => {
      const baseline = cells.baseline;
      const formatted = apps.map((app) => {
        const value = cells[app];
        if (value === null) return "not observed";
        if (typeof value !== "number") return String(value);
        const absolute = value.toFixed(decimals);
        if (!relative || app === "baseline" || typeof baseline !== "number") return absolute;
        const percent =
          baseline === 0 ? "n/a" : `${signed(((value - baseline) * 100) / baseline, 1)}%`;
        return `${absolute} (${signed(value - baseline, decimals)}; ${percent})`;
      });
      return `| ${label} | ${formatted.join(" | ")} |`;
    }),
    "",
  ];
}

function section(id) {
  return [
    "",
    `<a name="${id}"></a>`,
    "",
    `## ${reportSections.find((entry) => entry.id === id).title}`,
    "",
  ];
}

function workTable(samples) {
  const metrics = [
    ["Whole-app commits", "commits"],
    ["Queue render-work events", "queueRenders"],
    ["Row render-work events", "rowRenders"],
    ["Open-button render-work events", "openButtonRenders"],
    ["Favorite-button render-work events", "favoriteButtonRenders"],
  ];
  return comparisonTable([
    ...metrics.map(([label, key]) => ({
      label,
      values: values((app) => samples[app][key]),
      decimals: 0,
    })),
    {
      label: "Row mounts (not update events)",
      values: values((app) => samples[app].mounts.rows),
      decimals: 0,
    },
    {
      label: "Open-button mounts",
      values: values((app) => samples[app].mounts.openButtons),
      decimals: 0,
    },
    {
      label: "Favorite-button mounts",
      values: values((app) => samples[app].mounts.favoriteButtons),
      decimals: 0,
    },
  ]);
}

function durationTable(samples, boundaries) {
  return comparisonTable(
    boundaries.flatMap((boundary) => [
      {
        label: `${boundary} ACTUAL (ms)`,
        values: values((app) => samples[app].medianDurationMs[boundary]),
      },
      {
        label: `${boundary} BASE estimate (ms)`,
        values: values((app) => samples[app].medianBaseDurationMs[boundary]),
      },
    ]),
  );
}

function timingRows(samples, prefix = "") {
  return [
    ["DOM median (ms)", "medianDomMs"],
    ["DOM p90 (ms)", "p90DomMs"],
    ["Two-frame opportunity median (ms)", "medianPaintMs"],
    ["Two-frame opportunity p90 (ms)", "p90PaintMs"],
  ].map(([label, key]) => ({
    label: `${prefix}${label}`,
    values: values((app) => samples[app][key] ?? "no result change"),
  }));
}

export function renderComparison(report) {
  const selected = values((app) =>
    report.actions[app].find((action) => action.name === "select incident"),
  );
  const filtering = report.interactions.filtering;
  const overview = [
    {
      label: "[Initial assets, gzip (kB)](#page-load)",
      values: values((app) => report.bundles[app].total.gzip / 1000),
      decimals: 2,
    },
    {
      label: "[Full table readiness, median (ms)](#page-load)",
      values: values((app) => report.load[app].medianMs),
    },
    {
      label: "[Open detail DOM, median (ms)](#row-selection)",
      values: values((app) => report.interactions.selection[app].medianDomMs),
    },
    {
      label: "[Narrow query AP DOM, median (ms)](#query-filtering)",
      values: values((app) => filtering.apps[app][1].medianDomMs),
    },
    {
      label: "[Clear query DOM, median (ms)](#query-filtering)",
      values: values((app) => filtering.apps[app][3].medianDomMs),
    },
  ].map((row) => ({ ...row, relative: true }));
  const lines = [
    "# Memoization in the incident triage app",
    "",
    "The same 200-incident app, data and controls: **No memoization**, **Manual memoization**, and **React Compiler**. These are local Chromium lab measurements, not production field telemetry. The compiler arm uses the experimental Oxc integration; results describe this integration and workload, not every React Compiler implementation.",
    "",
    reportSections.map(({ id, title }) => `[${title}](#${id})`).join(" / "),
    ...section("overview"),
    `**${report.evaluation.recommendation}**`,
    "",
    ...comparisonTable(overview),
    "Parentheses show absolute change and percentage against No memoization: negative means fewer bytes or less time, positive means more. Percentages use the unrounded report values, not rounded display cells. A zero reference gives n/a. Each row is its own endpoint; different workloads and protocols are never pooled into a score or ranking.",
    "",
    report.evaluation.rationale,
    "",
    report.evaluation.caveat,
    ...section("page-load"),
    "### Initial-load production bytes",
    "",
    "Normal production builds only. All sizes use decimal kB (1 kB = 1,000 bytes); exact bytes remain in [comparison.json](comparison.json). Parentheses are differences against No memoization.",
    "",
    ...comparisonTable(
      ["js", "css", "total"].flatMap((kind) =>
        ["raw", "gzip"].map((encoding) => ({
          label: `${kind.toUpperCase()} ${encoding} (kB)`,
          values: values((app) => report.bundles[app][kind][encoding] / 1000),
          decimals: 2,
          relative: true,
        })),
      ),
    ),
    "Manifest entry JS, static imports, and attached CSS counted once per file. Source maps, dynamic imports, and profile builds excluded. Bundle bytes do not measure parse time or interaction latency.",
    `Separately loaded chunks: ${apps.map((app) => `${labels[app]}: ${report.bundles[app].loadedLater.join(", ") || "none"}`).join("; ")}.`,
    "",
    "### User-perceived load time (UPLT)",
    "",
    "UPLT is navigation start to the full 200-row incident table completing two animation frames (a paint opportunity). Fresh isolated contexts, normal production builds, 4x CDP CPU slowdown, six runs covering all six app-order permutations, with each app in each position twice; no network throttling. This is a lab readiness proxy, not a Core Web Vital, guaranteed paint or an input-response metric.",
    "",
    ...comparisonTable([
      {
        label: "Median readiness (ms)",
        values: values((app) => report.load[app].medianMs),
        relative: true,
      },
      {
        label: "Run 1 / 2 / 3 / 4 / 5 / 6 (ms)",
        values: values((app) => report.load[app].samplesMs.join(" / ")),
      },
    ]),
    ...loadMemoryMarkdown(report.loadMemory, 3),
    "### Lighthouse (mobile lab)",
    "",
    `Lighthouse ${report.versions.lighthouse}, ${report.lighthouse.settings.formFactor} preset with ${report.lighthouse.settings.throttlingMethod} throttling, normal builds. Three fresh Chrome launches per app, alternating order. Scores are 0-100, timings are milliseconds and CLS is unitless. Median metrics are advisory; this protocol is separate from the desktop 4x CDP setup. ${apps.map((app) => `[${labels[app]} raw audit](lighthouse-${app}.json)`).join(" / ")}.`,
    "",
    ...comparisonTable(
      [
        ["Performance score", "performanceScore"],
        ["Accessibility score", "accessibilityScore"],
        ["FCP (ms)", "fcpMs"],
        ["LCP (ms)", "lcpMs"],
        ["TBT (ms)", "tbtMs"],
        ["Speed Index (ms)", "speedIndexMs"],
        ["CLS", "cls"],
        ["Time to Interactive (ms)", "interactiveMs"],
      ].map(([label, key]) => ({
        label,
        values: values((app) => report.lighthouse[app][key]),
        decimals: key === "cls" ? 3 : 1,
      })),
    ),
    ...section("row-selection"),
    "**Path:** Platform queue, 67 visible incidents, no detail selected, open INC-0001. Closing the detail is an untimed reset, not a measured endpoint.",
    "",
    "### Selection responsiveness (normal production builds)",
    "",
    "One open/close warm-up followed by 20 warmed trials per app, isolated contexts, rotated app order and 4x CDP CPU slowdown. Timing starts in the browser click handler and stops at the correct detail DOM mutation, then at two animation-frame callbacks. The latter is a paint opportunity, not guaranteed presentation or INP. Playwright latency and React profiling overhead are excluded. Per-trial results remain in [selection-latency.json](selection-latency.json).",
    "",
    ...comparisonTable(timingRows(report.interactions.selection)),
    "### Selection component work (profiling builds)",
    "",
    "Same selection state and target, separate native-speed profiling builds, one warm-up and medians of three rotated repetitions. Render-work events count completed update work, not milliseconds or DOM mutations. Counts and timings come from different runs and are not directly interchangeable.",
    "",
    ...workTable(selected),
    "### Selection inclusive Profiler durations",
    "",
    "ACTUAL is React's measured subtree render duration; BASE is an estimate, not an unoptimized comparison run. These are per-run callback medians, not end-to-end selection time. See the expanded methodology below.",
    "",
    ...durationTable(selected, [
      "root",
      "shell",
      "toolbar",
      "list",
      "detail",
      "rows",
      "queueItems",
      "openButtons",
      "favoriteButtons",
    ]),
    "### Why equal row counts do not mean equal work",
    "",
    selectionEvidence(report.actions),
    "",
    report.rowCaching.explanation,
    "",
    `This explanation is scoped to oxc-transform-react ${report.versions.oxcTransformReact} and the inspected measured output. [Compiler App snapshot](sources/compiler-App.js) / [Manual App snapshot](sources/manual-App.js) are post-transform, pre-bundle inspection artifacts; later bundling and minification can change shipped code.`,
    "",
    ...(report.rowCaching.excerpts ?? []).flatMap(({ label, code }) => [
      `**${label}**`,
      "",
      "```js",
      code,
      "```",
      "",
    ]),
    ...section("query-filtering"),
    "**Path:** All incidents, 200 rows, All statuses, newest sort and no selected detail. Type A, then AP, then API; clear once to restore the initial list. This path runs independently of selection and favorite edits. Expected rows: **200 / 34 / 34 / 200**.",
    "",
    "### Filtering responsiveness (normal production builds)",
    "",
    "One complete warm-up, then 20 warmed cycles per app with rotated order, isolated contexts and 4x CDP CPU slowdown. Timing starts at the native input event before the React handler. AP and clear stop at the correct result-list mutation, followed by two frame callbacks. A and API leave result IDs unchanged: no result-DOM endpoint exists, so DOM timing is null, not zero; their input-to-two-frame opportunity still measures response work. Every endpoint verifies the exact ordered IDs and input value. This synchronous workload has no debounce or pending async search.",
    "",
    "Typing uses at least 100 ms pacing between input steps; pacing, Playwright waits, setup and reset are excluded from the measured endpoints. Clearing is one input change, not repeated backspace. Medians and nearest-rank p90 are computed per step across 20 cycles; they are not summed into a workflow total. [Raw typed-filtering trials](filtering-latency.json).",
    "",
    ...comparisonTable(
      filtering.protocol.steps.flatMap((step, index) =>
        timingRows(
          values((app) => filtering.apps[app][index]),
          `${step.name} / `,
        ),
      ),
    ),
    "### Filtering component work (profiling builds)",
    "",
    "Fresh default state per profiling run, one warm-up and three native-speed repetitions with rotated order. Clearing remounts 166 previously removed rows; mounts are shown separately and are not counted as render-work update events. Inclusive ACTUAL/BASE callback medians below have diagnostic overhead, not production response timing.",
    "",
    ...filtering.protocol.steps.flatMap((step, index) => {
      const samples = values((app) => report.paths.filtering[app][index]);
      return [
        `#### ${step.name} (${step.rows} rows)`,
        "",
        ...workTable(samples),
        ...durationTable(samples, ["root", "toolbar", "list"]),
      ];
    }),
    ...section("evidence"),
    "### Component work and committed updates (median of 3 runs)",
    "",
    "Additional actions come from the existing stateful workflow: review, Platform queue, selection, favorite, bulk search INC-0001, status filter, sort/reset, resolve. The bulk search is not the independent typed-query benchmark above; sort/reset combines four operations. No production latency is claimed for these additional actions.",
    "",
    ...report.actions.baseline
      .filter((action) => action.name !== "select incident")
      .flatMap((action) => [
        `#### ${action.name === "search" ? "search (legacy bulk input)" : action.name}`,
        "",
        ...workTable(
          values((app) => report.actions[app].find((entry) => entry.name === action.name)),
        ),
      ]),
    "### Favorite interaction: post-GC JS heap (normal builds)",
    "",
    "Separate favorite diagnostic, not load-window memory or selection/filtering allocation. The six UPLT contexts at 4x CPU slowdown also sample Performance.JSHeapUsedSize after forced GC at table readiness and after favoriting INC-0001. Medians of six paired runs; GC is outside load/CPU windows. This is renderer JS heap, not total tab/DOM/native memory or a leak test. Full runs remain in comparison.json.",
    "",
    ...comparisonTable([
      {
        label: "Before favorite (MiB)",
        values: values((app) => report.memory[app].beforeBytes / 1048576),
        decimals: 2,
      },
      {
        label: "After favorite (MiB)",
        values: values((app) => report.memory[app].afterBytes / 1048576),
        decimals: 2,
      },
      {
        label: "Paired median change (KiB)",
        values: values((app) => report.memory[app].deltaBytes / 1024),
      },
    ]),
    "### Favorite interaction: CPU slowdown flame charts",
    "",
    "One normal-build favorite trace per app at 4x CPU slowdown. JS-active sampled time excludes V8 (idle) and (program). It is an approximate slice of the sampled window, not end-to-end response time or a render count. Captures include Playwright-triggered work and cannot establish a performance winner. Each chart has its own time scale; compare measured values, not chart widths. Raw profiles open in Chrome DevTools.",
    "",
    ...comparisonTable([
      { label: "Sampled window (ms)", values: values((app) => report.cpu[app].sampledMs) },
      { label: "JS-active sampled time (ms)", values: values((app) => report.cpu[app].activeJsMs) },
      { label: "JS-active share (%)", values: values((app) => report.cpu[app].activeSharePercent) },
    ]),
    ...apps.flatMap((app) => [
      `#### ${labels[app]} (${report.cpu[app].samples} samples)`,
      "",
      `![${app} CPU flame chart](${report.cpu[app].chart})`,
      "",
      `[Open raw ${labels[app]} CPU profile](${report.cpu[app].profile})`,
      "",
    ]),
    ...ablationMarkdown(report.rowMemo, 3),
    ...section("methodology"),
    "### Reading the Profiler durations",
    "",
    `A render-work event marks an already-mounted component whose React ${report.versions.react} profiling fiber records PerformedWork in a completed update. A component may contribute events in multiple commits. Events are **not milliseconds, equal-cost CPU operations, DOM mutations, or a complete function-invocation count**. Only whole-app commits come from the external root React \`<Profiler>\`; nested callbacks do not prove the wrapped component ran. These internal diagnostics are not additive or an API guaranteed across React releases.`,
    "",
    "Root includes App and provider render bodies; shell, toolbar, list, detail, rows, queue items and buttons are inclusive subtree measurements. Overlapping root/parent/child durations are never summed into a total or treated as component self-time.",
    "",
    "ACTUAL (actualDuration) is measured subtree render work. BASE (baseDuration) is React's estimated full-subtree render cost from the most recent measured component costs, not a separately measured unoptimized run. It may retain earlier costs and does not undo useMemo/compiler caches or reconstruct uncached calculation costs. BASE minus ACTUAL is not measured savings. Neither is event-handler, layout, paint or end-to-end interaction time.",
    "",
    "Whole-app commits count one external root callback per [rootId, rootGeneration, commitSequence]. Initial mounts are outside action windows; action mounts stay separate from update events. Capture waits for semantic outcomes and completed batches in this synchronous workload, not arbitrary future asynchronous work.",
    "",
    "In [comparison.json](comparison.json), medianDurationMs (ACTUAL) and medianBaseDurationMs (BASE) are independently computed medians across per-run callback medians, not interaction totals. Mount summaries and raw runs stay separate; null means no matching callback was observed, while 0 is a measured zero. Raw durations and lifecycle identities remain in [measurements.json](measurements.json). All Profiler durations include diagnostic overhead and are advisory, never CI timing thresholds. Native profiling is separate from normal-build 4x timings and browser sampling diagnostics.",
    "",
    "### Versions and provenance",
    "",
    `Node ${report.versions.node}; Chromium ${report.versions.playwrightChromium}; React ${report.versions.react}; Vite ${report.versions.vite}; plugin-react ${report.versions.pluginReact}; oxc-transform-react ${report.versions.oxcTransformReact}; Oxlint ${report.versions.oxlint}.`,
    "",
    report.workload,
    "",
    "[Source, build and measurement fingerprints](provenance.json) bind these observations to one capture. Missing or mismatched evidence fails publication rather than mixing results from different runs.",
    "",
  ];
  return lines.join("\n");
}

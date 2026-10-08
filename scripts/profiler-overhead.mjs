import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { measureBundle } from "./bundle-size.mjs";
import { hashFiles, sourceFingerprint } from "./benchmark-provenance.mjs";
import { resultsDirectory } from "./benchmark-results.mjs";
import { median } from "./profile-counts.mjs";
import { heapFields, validateHeapUsage } from "../benchmark/load-memory.mjs";

export const profilerApps = ["baseline"];
export const profilerArms = ["production", "profile-tracks", "profile-granular"];
export const profilerDirectories = {
  production: "dist",
  "profile-tracks": "dist-profile-tracks",
  "profile-granular": "dist-profile-granular",
};
export const profilerOrders = [
  ["production", "profile-tracks", "profile-granular"],
  ["profile-tracks", "profile-granular", "production"],
  ["profile-granular", "production", "profile-tracks"],
  ["profile-granular", "profile-tracks", "production"],
  ["profile-tracks", "production", "profile-granular"],
  ["production", "profile-granular", "profile-tracks"],
];
export const profilerProtocol = {
  app: "baseline",
  loadCpuRates: [1, 4],
  resourceCpuRate: 1,
  viewport: { width: 1440, height: 900 },
  repetitions: 6,
  orders: profilerOrders,
  cache: "disabled",
  callback: "identical stable no-op; no recorder",
  boundaries: {
    production: "none",
    "profile-tracks": "one root",
    "profile-granular": "existing root plus shell/toolbar/list/detail/queues/rows/buttons",
  },
  readiness: "200 rows followed by two animation-frame callbacks",
  cpu: "SystemInfo.getProcessInfo cumulative renderer all-thread CPU delta in seconds converted to ms; stable renderer IDs required",
  rss: "resident set bytes summed over renderer processes; Linux /proc/status or macOS ps rss; not private memory, process-tree total or a sampled peak",
  heap: "Runtime.getHeapUsage; separate load sampling and post-GC snapshots",
  workflow: {
    cycles: 20,
    warmups: 1,
    query: "API",
    minimumKeyDelayMs: 100,
    actions: ["open detail", "favorite", "unfavorite", "close detail", "type API", "clear query"],
  },
  isolation:
    "fresh browser per arm and repetition; latency, CPU, heap/RSS and traces in separate passes",
};
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function profilerProtocolFingerprint(root = process.cwd()) {
  return sha256(
    JSON.stringify(
      hashFiles(root, [
        "playwright.profiler.config.ts",
        "benchmark/profiler-overhead.spec.mts",
        "benchmark/load-memory.mjs",
        "scripts/run-profiler-overhead.mjs",
        "scripts/profiler-overhead.mjs",
        "scripts/profile-counts.mjs",
        "scripts/bundle-size.mjs",
        "scripts/benchmark-results.mjs",
        "scripts/benchmark-provenance.mjs",
      ]),
    ),
  );
}

function summary(values) {
  assert.ok(
    values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0),
    "Samples must be finite nonnegative numbers",
  );
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: median(values),
    p90: sorted[Math.ceil(values.length * 0.9) - 1],
    count: values.length,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

export function delta(reference, candidate) {
  assert.equal(reference.length, candidate.length, "Unequal matched samples");
  if ([...reference, ...candidate].every((value) => value === null)) return null;
  assert.ok(![...reference, ...candidate].includes(null), "Mixed missing/observed endpoint");
  const before = summary(reference),
    after = summary(candidate);
  const absolute = after.median - before.median;
  return {
    reference: before,
    candidate: after,
    absolute,
    percent: before.median === 0 ? null : (absolute * 100) / before.median,
    matchedDifferences: reference.map((value, index) => candidate[index] - value),
  };
}

export function rendererCpuDelta(before, after) {
  assert.ok(before.length > 0, "Missing renderer process counters");
  assert.deepEqual(
    after.map((entry) => entry.id),
    before.map((entry) => entry.id),
    "Renderer process identities changed",
  );
  return after.reduce((sum, entry, index) => {
    assert.equal(entry.type, "renderer");
    assert.equal(before[index].type, "renderer");
    assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0);
    assert.ok(Number.isFinite(before[index].cpuTime) && before[index].cpuTime >= 0);
    assert.ok(
      Number.isFinite(entry.cpuTime) && entry.cpuTime >= before[index].cpuTime,
      "CPU counter is not cumulative",
    );
    return sum + (entry.cpuTime - before[index].cpuTime) * 1000;
  }, 0);
}

export function profilerBuilds(root = process.cwd()) {
  return {
    baseline: Object.fromEntries(
      profilerArms.map((arm) => {
        const directory = resolve(root, `apps/baseline/${profilerDirectories[arm]}`);
        const bundle = measureBundle(directory);
        return [arm, { bundle, files: hashFiles(directory, Object.values(bundle.files).flat()) }];
      }),
    ),
  };
}

export function parseTracks(trace, profiling) {
  assert.ok(Array.isArray(trace?.traceEvents), "Missing traceEvents");
  const markers = new Map(),
    components = [],
    scheduler = [];
  for (const event of trace.traceEvents) {
    if (
      event.cat?.split(",").includes("blink.user_timing") &&
      /^overhead:(start|end):/.test(event.name)
    ) {
      assert.ok(!markers.has(event.name), `Duplicate action marker ${event.name}`);
      assert.ok(Number.isFinite(event.ts), "Invalid marker timestamp");
      markers.set(event.name, event);
    }
    const data = event.args?.data;
    if (event.name !== "TimeStamp" || !event.cat?.split(",").includes("devtools.timeline") || !data)
      continue;
    if (data.track === "Components \u269b")
      components.push({ ...data, pid: event.pid, tid: event.tid });
    if (data.trackGroup === "Scheduler \u269b") scheduler.push(data);
  }
  if (profiling) {
    assert.ok(scheduler.length, "Scheduler metadata missing; inspect React/Chromium versions");
    assert.ok(
      components.length,
      "Components metadata missing; check Profiler and trace categories",
    );
  } else
    assert.equal(components.length + scheduler.length, 0, "Normal production exposed React tracks");
  for (const entry of components) {
    assert.ok(
      Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end >= entry.start,
      "Invalid component timestamp range",
    );
    assert.ok(
      typeof entry.name === "string" && entry.name.length > 0,
      "Missing runtime component label",
    );
  }
  const windows = {};
  for (const [key, start] of markers) {
    if (!key.startsWith("overhead:start:")) continue;
    const name = key.slice("overhead:start:".length),
      end = markers.get(`overhead:end:${name}`);
    assert.ok(end, `Missing end marker for ${name}`);
    assert.ok(
      end.ts >= start.ts && end.pid === start.pid && end.tid === start.tid,
      "Invalid action marker range",
    );
    const events = components.filter(
      (entry) =>
        entry.pid === start.pid &&
        entry.tid === start.tid &&
        entry.start >= start.ts &&
        entry.end <= end.ts,
    );
    const groups = {};
    let renderEvents = 0,
      effectEvents = 0,
      errorOrAmbiguousEvents = 0;
    for (const entry of events) {
      if (/^(primary|tertiary)(-light|-dark)?$/.test(entry.color)) {
        renderEvents++;
        const group = (groups[entry.name] ??= { instances: null, inclusiveDurationsMs: [] });
        group.inclusiveDurationsMs.push((entry.end - entry.start) / 1000);
      } else if (/^secondary(-light|-dark)?$/.test(entry.color)) effectEvents++;
      else errorOrAmbiguousEvents++;
    }
    windows[name] = {
      renderEvents,
      effectEvents,
      errorOrAmbiguousEvents,
      components: Object.fromEntries(
        Object.entries(groups).map(([label, group]) => [
          label,
          { ...group, durations: summary(group.inclusiveDurationsMs) },
        ]),
      ),
    };
  }
  for (const key of markers.keys())
    if (key.startsWith("overhead:end:"))
      assert.ok(
        markers.has(key.replace("overhead:end:", "overhead:start:")),
        "Missing start marker",
      );
  return {
    schedulerEvents: scheduler.length,
    componentEvents: components.length,
    windows,
    limitation:
      "Recorded events, not exact commits or function invocations. Labels may collide; inclusive durations overlap. Mount/instance identities are unavailable.",
  };
}

function validateRuns(input, key, rates) {
  const runs = input[key];
  assert.equal(
    runs?.length,
    profilerOrders.length * rates.length,
    `${key}: six complete repetitions per rate required`,
  );
  const identities = new Set();
  for (const run of runs) {
    assert.equal(run.app, "baseline", "Only Baseline is measured");
    assert.ok(rates.includes(run.cpuRate), "Invalid resource/latency CPU rate");
    assert.ok(
      Number.isInteger(run.repeat) && run.repeat >= 0 && run.repeat < 6,
      "Invalid repetition",
    );
    const identity = `${run.cpuRate}:${run.repeat}`;
    assert.ok(!identities.has(identity), "Duplicate repetition");
    identities.add(identity);
    assert.deepEqual(
      run.order,
      profilerOrders[run.repeat],
      "Run order must cover all six arm permutations",
    );
    assert.deepEqual(Object.keys(run.arms).sort(), [...profilerArms].sort(), "Incomplete arm set");
    for (const arm of profilerArms) {
      const sample = run.arms[arm];
      assert.deepEqual(sample.state, run.arms.production.state, "Behavior mismatch");
      assert.equal(sample.state.rows, 200);
      assert.equal(sample.state.search, "");
      assert.equal(sample.state.selected, null);
      assert.equal(sample.state.favorite, false);
      if (key === "loadRuns") summary([sample.upltMs]);
      if (key === "cpuRuns") {
        summary([sample.loadCpuMs, sample.workflowCpuMs]);
        assert.equal(
          sample.loadCpuMs,
          rendererCpuDelta(sample.processCounters.beforeLoad, sample.processCounters.afterLoad),
          "Load CPU differs from raw counters",
        );
        assert.equal(
          sample.workflowCpuMs,
          rendererCpuDelta(
            sample.processCounters.beforeWorkflow,
            sample.processCounters.afterWorkflow,
          ),
          "Workflow CPU differs from raw counters",
        );
      }
      if (key === "memoryRuns") {
        assert.ok(sample.loadSamples.length > 0, "Missing load heap samples");
        for (const heap of [
          sample.beforeNavigation,
          ...sample.loadSamples,
          sample.ready,
          sample.postGC,
          sample.workflowPostGC,
        ])
          validateHeapUsage(heap);
        for (const field of ["readyRssBytes", "postGCRssBytes", "workflowRssBytes"]) {
          assert.ok(
            Number.isSafeInteger(sample[field]) && sample[field] > 0,
            "Missing positive renderer RSS counter",
          );
        }
      }
    }
  }
}

export function analyzeProfiler(input) {
  assert.equal(
    input?.schemaVersion,
    2,
    "Unsupported placement schema; rerun the Baseline experiment",
  );
  assert.equal(input.experiment, "baseline-profiler-placement");
  assert.deepEqual(input.protocol, profilerProtocol, "Placement protocol differs");
  assert.match(input.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(input.protocolFingerprint, /^[a-f0-9]{64}$/, "Missing protocol identity");
  assert.ok(
    typeof input.browser === "string" && input.browser.length > 0,
    "Missing browser identity",
  );
  validateRuns(input, "loadRuns", [1, 4]);
  validateRuns(input, "cpuRuns", [1]);
  validateRuns(input, "memoryRuns", [1]);
  const contrasts = [
    ["production", "profile-tracks"],
    ["production", "profile-granular"],
    ["profile-tracks", "profile-granular"],
  ];
  const results = contrasts.map(([reference, candidate]) => {
    const endpoint = (name, unit, runs, get) => ({
      name,
      unit,
      ...delta(
        runs.map((run) => get(run.arms[reference])),
        runs.map((run) => get(run.arms[candidate])),
      ),
    });
    const endpoints = [1, 4].map((rate) =>
      endpoint(
        `load readiness ${rate}x`,
        "ms",
        input.loadRuns.filter((run) => run.cpuRate === rate),
        (sample) => sample.upltMs,
      ),
    );
    endpoints.push(
      endpoint("load renderer CPU", "CPU ms", input.cpuRuns, (sample) => sample.loadCpuMs),
      endpoint("workflow renderer CPU", "CPU ms", input.cpuRuns, (sample) => sample.workflowCpuMs),
    );
    for (const field of heapFields)
      for (const phase of ["sampledPeak", "ready", "postGC", "workflowPostGC"])
        endpoints.push(
          endpoint(`${phase} ${field}`, "bytes", input.memoryRuns, (sample) =>
            phase === "sampledPeak"
              ? Math.max(...sample.loadSamples.map((entry) => entry[field]), sample.ready[field])
              : sample[phase][field],
          ),
        );
    for (const [name, field] of [
      ["ready renderer RSS", "readyRssBytes"],
      ["post-GC renderer RSS", "postGCRssBytes"],
      ["workflow renderer RSS", "workflowRssBytes"],
    ])
      endpoints.push(endpoint(name, "bytes", input.memoryRuns, (sample) => sample[field]));
    return { app: "baseline", reference, candidate, endpoints };
  });
  return {
    schemaVersion: 2,
    experiment: input.experiment,
    sourceFingerprint: input.sourceFingerprint,
    protocolFingerprint: input.protocolFingerprint,
    browser: input.browser,
    environment: input.environment,
    protocol: input.protocol,
    results,
    interpretation:
      "Positive candidate-minus-reference differences are overhead. Only Baseline is measured. Profiling arms use identical no-op callbacks and no recorder. Root-to-production includes runtime and root boundary; granular-to-root isolates existing extra boundary placement. No telemetry collection/upload cost is measured. Six same-session repetitions are descriptive, not a speed gate or equivalence proof.",
  };
}

const labels = {
  production: "Normal production",
  "profile-tracks": "Root Profiler",
  "profile-granular": "Granular Profilers",
};
const signed = (value) =>
  value === null ? "n/a" : `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}`;
const format = (value) => Number(value.toFixed(2));

export function renderProfiler(report, tracks) {
  const metrics = [
    "load readiness 1x",
    "load readiness 4x",
    "load renderer CPU",
    "workflow renderer CPU",
    "sampledPeak usedSize",
    "postGC usedSize",
    "workflowPostGC usedSize",
    "postGC embedderHeapUsedSize",
    "post-GC renderer RSS",
    "workflow renderer RSS",
  ];
  const lines = [
    "# Baseline Profiler placement overhead",
    "",
    "Baseline only: no React Compiler or manual memoization. Normal production, one root Profiler, and the existing root-plus-granular placement. Both profiling builds use the same stable no-op callback. No Scan, diagnostic recorder, DevTools hook or telemetry upload.",
    "",
    report.interpretation,
    "",
    `Chromium ${report.browser}; React ${report.environment.react}; ${report.environment.platform}/${report.environment.arch}; CPU ${report.environment.cpu}.`,
    "",
    "[Raw measurements](measurements.json) / [Authenticated evidence](provenance.json) / [Computed results](comparison.json)",
    "",
    "## Percentage overhead",
    "",
    "| Metric | Root vs production | Granular vs production | Granular vs root |",
    "| --- | ---: | ---: | ---: |",
    ...metrics.map(
      (name) =>
        `| ${name} | ${report.results
          .map((result) => {
            const entry = result.endpoints.find((entry) => entry.name === name);
            return entry.percent === null ? "n/a" : `${signed(entry.percent)}%`;
          })
          .join(" | ")} |`,
    ),
    "",
    "Positive means more time, CPU or memory. Percentages use unrounded medians; zero references are unavailable. Sample counts, ranges and matched raw differences remain in comparison.json. These six-repetition summaries are not confidence intervals.",
    "",
    "## Initial assets",
    "",
    "| Arm | JS raw / gzip (bytes) | Total raw / gzip (bytes) |",
    "| --- | ---: | ---: |",
    ...profilerArms.map((arm) => {
      const bundle = report.builds.baseline[arm].bundle;
      return `| ${labels[arm]} | ${bundle.js.raw} / ${bundle.js.gzip} | ${bundle.total.raw} / ${bundle.total.gzip} |`;
    }),
    "",
    "| Asset comparison | Raw total delta / % | Gzip total delta / % |",
    "| --- | ---: | ---: |",
    ...report.results.map(({ reference, candidate }) => {
      const before = report.builds.baseline[reference].bundle.total,
        after = report.builds.baseline[candidate].bundle.total;
      return `| ${labels[candidate]} vs ${labels[reference]} | ${signed(after.raw - before.raw)} / ${signed(((after.raw - before.raw) * 100) / before.raw)}% | ${signed(after.gzip - before.gzip)} / ${signed(((after.gzip - before.gzip) * 100) / before.gzip)}% |`;
    }),
    "",
    "Initial JS/CSS and static imports counted once, per-file gzip. CSS is byte-identical; source snapshots/maps and late imports are excluded.",
    "",
  ];
  for (const result of report.results)
    lines.push(
      `## ${labels[result.candidate]} vs ${labels[result.reference]}`,
      "",
      "| Endpoint | Reference median / p90 | Candidate median / p90 | Delta / % |",
      "| --- | ---: | ---: | ---: |",
      ...result.endpoints.map(
        (entry) =>
          `| ${entry.name} (${entry.unit}) | ${format(entry.reference.median)} / ${format(entry.reference.p90)} | ${format(entry.candidate.median)} / ${format(entry.candidate.p90)} | ${signed(entry.absolute)} / ${entry.percent === null ? "n/a" : `${signed(entry.percent)}%`} |`,
      ),
      "",
    );
  lines.push(
    "## CPU and memory methodology",
    "",
    "Latency runs use fresh browsers, disabled cache, and both 1x/4x CPU rates. Resource consumption runs use 1x CPU only: throttled elapsed time is not CPU time. Every separate pass covers all six three-arm permutations, with each arm in every order position twice.",
    "",
    "CPU runs use SystemInfo.getProcessInfo to measure cumulative renderer CPU consumed across threads during load and twenty warmed workflows. Renderer process identity must remain stable across each interval. No tracing, sampling profiler, forced GC or heap/RSS polling runs in CPU windows. This includes renderer/browser-in-page work, not exclusively React, GPU time or whole-browser CPU. Browser automation and frame waits remain part of the defined workload.",
    "",
    "The workflow opens detail, favorites/unfavorites the incident, closes detail, types API, then clears the query, with exact semantic results verified. Clearing is a reproducible remount workload, not a reported DOM-latency metric. A warm-up runs outside CPU measurement. Final state and accumulated history are identical across arms.",
    "",
    "Separate memory runs sample JS/embedder/allocated/backing-store heap during load; report readiness before forced GC, post-GC retention, then post-GC retention after twenty workflows. Sampled maxima are observed heap peaks, not true peaks. RSS snapshots sum resident bytes across renderer processes: shared pages may be counted more than once; RSS is not private memory or total browser-tree memory. RSS is recorded at readiness and after GC/workflow, not polled as a peak. Linux /proc/status and macOS ps rss are supported. OS/disk caches and allocator retention can vary; this is not a leak test.",
    "",
    "## Separate Performance Tracks",
    "",
    "Tracks are diagnostic render events, not CPU consumption, exact committed updates or unique instances. Inclusive component durations overlap. Minified labels may collide. Traces never enter latency/CPU/memory overhead estimates.",
    "",
  );
  if (tracks)
    lines.push(
      "[Structured component evidence](component-work.json)",
      "",
      "| Placement | Window | Render events | Effect events | Trace |",
      "| --- | --- | ---: | ---: | --- |",
      ...profilerArms
        .filter((arm) => arm !== "production")
        .flatMap((arm) =>
          Object.entries(tracks.apps.baseline[arm].windows).map(
            ([name, window]) =>
              `| ${labels[arm]} | ${name} | ${window.renderEvents} | ${window.effectEvents} | [Chrome trace](traces/baseline-${arm}.json) |`,
          ),
        ),
      "",
    );
  else lines.push("Trace evidence unavailable; run benchmark:profiler:tracks separately.", "");
  lines.push(
    "## Reproduction",
    "",
    "Run benchmark:profiler in the isolated worktree with a fresh BENCHMARK_RESULTS_DIR. Run benchmark:profiler:tracks with the same directory separately. Repeat independent sessions before choosing a practical shipping budget. Historical three-app results are stored in profiler-overhead-summary.md, not relabeled under this protocol.",
    "",
  );
  return lines.join("\n");
}

export function readProfilerEvidence(directory, expectedFingerprint = sourceFingerprint()) {
  const provenance = JSON.parse(readFileSync(`${directory}/provenance.json`, "utf8"));
  assert.equal(
    provenance.schemaVersion,
    2,
    "Old profiler experiment: regenerate placement evidence",
  );
  assert.equal(
    provenance.sourceFingerprint,
    expectedFingerprint,
    "Profiler sources changed; rerun",
  );
  assert.equal(
    provenance.protocolFingerprint,
    profilerProtocolFingerprint(),
    "Profiler protocol changed; rerun",
  );
  for (const name of ["measurements.json", "comparison.json", "comparison.md", "report.html"])
    assert.match(
      provenance.artifacts?.[name],
      /^[a-f0-9]{64}$/,
      `Missing authenticated artifact ${name}`,
    );
  for (const [name, hash] of Object.entries(provenance.artifacts))
    assert.equal(
      sha256(readFileSync(`${directory}/${name}`)),
      hash,
      `Profiler artifact changed: ${name}`,
    );
  const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
  const report = JSON.parse(readFileSync(`${directory}/comparison.json`, "utf8"));
  assert.equal(input.sourceFingerprint, expectedFingerprint);
  assert.equal(input.protocolFingerprint, provenance.protocolFingerprint);
  assert.deepEqual(
    report,
    { ...analyzeProfiler(input), builds: provenance.builds },
    "Report does not match raw placement measurements",
  );
  const tracks = existsSync(`${directory}/component-work.json`)
    ? JSON.parse(readFileSync(`${directory}/component-work.json`, "utf8"))
    : null;
  if (tracks) {
    assert.equal(tracks.sourceFingerprint, expectedFingerprint);
    assert.equal(tracks.protocolFingerprint, provenance.protocolFingerprint);
    assert.match(provenance.artifacts["component-work.json"], /^[a-f0-9]{64}$/);
    assert.deepEqual(tracks.builds, provenance.builds);
    assert.equal(tracks.browser, report.browser);
    for (const [name, hash] of Object.entries(tracks.files))
      assert.equal(sha256(readFileSync(`${directory}/${name}`)), hash, "Trace changed");
    for (const arm of profilerArms)
      assert.deepEqual(
        tracks.apps.baseline[arm],
        parseTracks(
          JSON.parse(readFileSync(`${directory}/traces/baseline-${arm}.json`, "utf8")),
          arm !== "production",
        ),
        "Track summary differs",
      );
  }
  assert.equal(
    readFileSync(`${directory}/comparison.md`, "utf8"),
    renderProfiler(report, tracks),
    "Profiler markdown differs",
  );
  return { report, provenance, tracks };
}

export function writeProfilerReport(directory) {
  const input = JSON.parse(readFileSync(`${directory}/measurements.json`, "utf8"));
  assert.equal(input.sourceFingerprint, sourceFingerprint(), "Sources changed during measurement");
  assert.equal(
    input.protocolFingerprint,
    profilerProtocolFingerprint(),
    "Protocol changed during measurement",
  );
  const builds = profilerBuilds();
  assert.deepEqual(
    builds,
    JSON.parse(readFileSync(`${directory}/builds.json`, "utf8")),
    "Builds changed",
  );
  for (const arm of profilerArms) {
    assert.deepEqual(builds.baseline[arm].bundle.css, builds.baseline.production.bundle.css);
    const css = builds.baseline[arm].bundle.files.css;
    assert.deepEqual(
      hashFiles(`apps/baseline/${profilerDirectories[arm]}`, css),
      hashFiles("apps/baseline/dist", css),
      "CSS bytes differ",
    );
  }
  const report = { ...analyzeProfiler(input), builds };
  const tracks = existsSync(`${directory}/component-work.json`)
    ? JSON.parse(readFileSync(`${directory}/component-work.json`, "utf8"))
    : null;
  const markdown = renderProfiler(report, tracks);
  writeFileSync(`${directory}/comparison.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${directory}/comparison.md`, markdown);
  writeFileSync(
    `${directory}/report.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baseline Profiler placement overhead</title><style>body{max-width:1200px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui;color:#203032;background:#f6f8f8}table{display:block;overflow:auto;border-collapse:collapse;max-width:100%}th,td{padding:.5rem;border:1px solid #cbd5d8}a{color:#006f62}</style></head><body>${marked.parse(markdown)}</body></html>\n`,
  );
  const artifacts = [
    "measurements.json",
    "comparison.json",
    "comparison.md",
    "report.html",
    ...(tracks ? ["component-work.json"] : []),
  ];
  writeFileSync(
    `${directory}/provenance.json`,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        sourceFingerprint: input.sourceFingerprint,
        protocolFingerprint: input.protocolFingerprint,
        builds,
        artifacts: hashFiles(directory, artifacts),
      },
      null,
      2,
    )}\n`,
  );
  readProfilerEvidence(directory);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  writeProfilerReport(`${resultsDirectory()}/profiler-overhead`);

import { strict as assert } from "node:assert";
import {
  heapFields,
  loadMemoryOrders,
  memoryApps,
  sampleIntervalMs,
  validateHeapUsage,
} from "../benchmark/load-memory.mjs";
import { median } from "./profile-counts.mjs";

export const memoryPhases = ["ready", "sampledPeak", "postGC"];
export const displayedHeapFields = {
  usedSize: "JS heap used",
  embedderHeapUsedSize: "Embedder heap used",
};

export function analyzeLoadMemory(input, browserVersion) {
  assert.equal(
    input?.schemaVersion,
    1,
    "Load-memory measurements missing or unsupported; rerun yarn benchmark",
  );
  assert.equal(
    input.browser,
    browserVersion,
    "Load-memory browser differs from the main benchmark",
  );
  assert.ok(
    typeof input.browser === "string" && input.browser.length > 0,
    "Missing load-memory browser version",
  );
  assert.equal(input.cpuRate, 4);
  assert.deepEqual(input.viewport, { width: 1440, height: 900 });
  assert.equal(input.sampleIntervalMs, sampleIntervalMs);
  assert.equal(input.protocol, "Runtime.getHeapUsage");
  assert.equal(input.isolation, "fresh-browser-per-app-per-repetition");
  assert.equal(input.cache, "disabled");
  assert.equal(input.readiness, "200 rows followed by two animation-frame callbacks");
  assert.equal(
    input.repetitions?.length,
    loadMemoryOrders.length,
    "Six load-memory repetitions required",
  );
  const runs = Object.fromEntries(memoryApps.map((app) => [app, []]));
  function timestamp(value) {
    assert.ok(Number.isFinite(value) && value >= 0, "Invalid heap snapshot timestamp");
  }
  for (const [repeat, repetition] of input.repetitions.entries()) {
    assert.equal(repetition.repeat, repeat);
    assert.deepEqual(repetition.order, loadMemoryOrders[repeat], "Unbalanced load-memory order");
    assert.deepEqual(
      repetition.runs?.map((run) => run.app),
      repetition.order,
      "Missing or reordered app sample",
    );
    for (const run of repetition.runs) {
      assert.deepEqual(run.state, { rows: 200, total: "200", detailOpen: false });
      assert.ok(run.loadSamples?.length > 0, "No load-window heap samples");
      let previous = 0;
      for (const sample of [run.beforeNavigation, ...run.loadSamples, run.ready, run.postGC]) {
        validateHeapUsage(sample);
        timestamp(sample.startedMs);
        timestamp(sample.completedMs);
        assert.ok(
          sample.startedMs >= previous && sample.completedMs >= sample.startedMs,
          "Overlapping or reversed heap snapshots",
        );
        previous = sample.completedMs;
      }
      timestamp(run.navigationStartedMs);
      timestamp(run.readyObservedMs);
      assert.ok(run.navigationStartedMs >= run.beforeNavigation.completedMs);
      assert.ok(run.readyObservedMs >= run.navigationStartedMs);
      assert.ok(
        run.ready.startedMs >= run.readyObservedMs,
        "Readiness snapshot predates readiness",
      );
      assert.ok(run.loadSamples[0].startedMs >= run.navigationStartedMs);
      assert.ok(
        run.loadSamples.every((sample) => sample.startedMs <= run.readyObservedMs),
        "Load polling continued after observed readiness",
      );
      const sampledPeak = Object.fromEntries(
        heapFields.map((field) => [
          field,
          Math.max(...run.loadSamples.map((sample) => sample[field]), run.ready[field]),
        ]),
      );
      runs[run.app].push({
        repeat,
        ready: Object.fromEntries(heapFields.map((field) => [field, run.ready[field]])),
        sampledPeak,
        postGC: Object.fromEntries(heapFields.map((field) => [field, run.postGC[field]])),
      });
    }
  }
  const apps = Object.fromEntries(
    memoryApps.map((app) => [
      app,
      {
        phases: Object.fromEntries(
          memoryPhases.map((phase) => [
            phase,
            Object.fromEntries(
              heapFields.map((field) => {
                const values = runs[app].map((run) => run[phase][field]);
                return [
                  field,
                  {
                    medianBytes: median(values),
                    minBytes: Math.min(...values),
                    maxBytes: Math.max(...values),
                  },
                ];
              }),
            ),
          ]),
        ),
        runs: runs[app],
      },
    ]),
  );
  const deltas = Object.fromEntries(
    ["manual", "baseline"].map((reference) => [
      reference,
      Object.fromEntries(
        memoryPhases.map((phase) => [
          phase,
          Object.fromEntries(
            heapFields.map((field) => {
              const compiler = apps.compiler.phases[phase][field].medianBytes;
              const other = apps[reference].phases[phase][field].medianBytes;
              return [
                field,
                {
                  bytes: compiler - other,
                  percent: other === 0 ? null : ((compiler - other) * 100) / other,
                },
              ];
            }),
          ),
        ]),
      ),
    ]),
  );
  const samples = input.repetitions.flatMap((repetition) => repetition.runs);
  const coverage = {
    minLoadSamples: Math.min(...samples.map((run) => run.loadSamples.length)),
    maxLoadSamples: Math.max(...samples.map((run) => run.loadSamples.length)),
    maxLoadRequestMs: Math.max(
      ...samples.flatMap((run) =>
        [...run.loadSamples, run.ready].map((sample) => sample.completedMs - sample.startedMs),
      ),
    ),
    maxReadinessLagMs: Math.max(
      ...samples.map((run) => run.ready.completedMs - run.readyObservedMs),
    ),
  };
  return { apps, deltas, repetitions: loadMemoryOrders.length, sampleIntervalMs, coverage };
}

export function loadMemoryMarkdown(memory) {
  const phases = {
    ready: "Ready, before forced GC",
    sampledPeak: "Sampled load-window peak",
    postGC: "Ready, after forced GC",
  };
  const mib = (value) => (value / 1048576).toFixed(3);
  const percent = (value) => {
    if (value === null) return "n/a (zero reference)";
    const rounded = Number(value.toFixed(2));
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}%`;
  };
  return [
    "## Load memory (normal production builds)",
    "",
    "Separate memory-only loads: six repetitions per app, all six app orders, a fresh Chromium browser and context for each load, cache disabled, 1440 x 900 viewport and 4x CPU slowdown. Readiness is the full 200-row table followed by two animation-frame callbacks. No React profiling build, DevTools hook, CPU sampling, or forced GC runs during the load window; memory polling is not added to the existing load/interaction latency runs.",
    "",
    "**JS heap used** is CDP Runtime.getHeapUsage.usedSize (V8 used heap). **Embedder heap used** is embedderHeapUsedSize (the embedder's garbage-collected heap, including Blink-managed objects); it is not all native/DOM memory or total tab/process memory. CDP reports the corresponding isolate, not just React or a single execution context. Allocated JS heap (totalSize) and array-buffer/external-string backing storage (backingStorageSize) are retained separately in the raw data, not added into a claimed memory total.",
    "",
    "| Metric | Observation | Compiler MiB, median [min, max] | Manual MiB, median [min, max] | Baseline MiB, median [min, max] | Compiler vs manual | Compiler vs baseline |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(displayedHeapFields).flatMap(([field, label]) =>
      memoryPhases.map((phase) => {
        const cells = memoryApps.map((app) => {
          const value = memory.apps[app].phases[phase][field];
          return `${mib(value.medianBytes)} [${mib(value.minBytes)}, ${mib(value.maxBytes)}]`;
        });
        return `| ${label} | ${phases[phase]} | ${cells.join(" | ")} | ${percent(memory.deltas.manual[phase][field].percent)} | ${percent(memory.deltas.baseline[phase][field].percent)} |`;
      }),
    ),
    "",
    "Percentages compare the displayed medians, using manual or baseline as the denominator; negative means the compiler used less. Min/max show the six runs, not confidence intervals. No memory winner or statistical significance is inferred from this small local sample.",
    "",
    "Samples use Runtime.getHeapUsage with a requested 20 ms pause after each response. CDP scheduling and main-thread work can delay samples; timestamps bracket each request in the raw data. The sampled peak is the largest observed counter from navigation start through the readiness snapshot, not the true allocation peak; independent counter maxima need not occur together. Polling adds overhead, and natural GC can occur before any sample. Ready/pre-forced-GC values therefore include GC-timing noise, not just live retained objects.",
    "",
    `Observed coverage: **${memory.coverage.minLoadSamples}-${memory.coverage.maxLoadSamples} load-window samples per run**, plus the readiness snapshot. The longest load-window/readiness request spanned **${memory.coverage.maxLoadRequestMs.toFixed(1)} ms**; the largest readiness-to-snapshot completion lag was **${memory.coverage.maxReadinessLagMs.toFixed(1)} ms**. Sparse samples cannot rule out larger transient allocations between observations.`,
    "",
    "The post-GC snapshot follows HeapProfiler.collectGarbage and is a separate retained-memory diagnostic, not a cold-load peak or a leak test. The blank-page snapshot is preserved for context but is not subtracted: navigation can change the isolate. These are cold browser/cache runs, not cold OS/disk caches or real-user device measurements. [Raw load-memory samples](load-memory.json) include all counters, request timestamps, run order and readiness observations. Differences are observations for this workload, not proof of a compiler-caused reduction.",
    "",
  ];
}

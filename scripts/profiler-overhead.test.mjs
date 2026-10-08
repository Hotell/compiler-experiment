import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeProfiler,
  delta,
  parseTracks,
  profilerApps,
  profilerArms,
  profilerOrders,
  profilerProtocol,
  profilerProtocolFingerprint,
  readProfilerEvidence,
  rendererCpuDelta,
  renderProfiler,
} from "./profiler-overhead.mjs";
import { hashFiles } from "./benchmark-provenance.mjs";

function measurements() {
  const heap = { usedSize: 100, totalSize: 200, embedderHeapUsedSize: 50, backingStorageSize: 10 };
  const state = { rows: 200, search: "", selected: null, favorite: false };
  const counter = (seconds) => [{ id: 42, type: "renderer", cpuTime: seconds }];
  const sample = (index) => ({
    state: structuredClone(state),
    upltMs: 100 + index * 10,
    loadCpuMs: rendererCpuDelta(counter(1), counter(1 + (40 + index * 5) / 1000)),
    workflowCpuMs: rendererCpuDelta(counter(2), counter(2 + (200 + index * 50) / 1000)),
    processCounters: {
      beforeLoad: counter(1),
      afterLoad: counter(1 + (40 + index * 5) / 1000),
      beforeWorkflow: counter(2),
      afterWorkflow: counter(2 + (200 + index * 50) / 1000),
    },
    beforeNavigation: heap,
    loadSamples: [heap],
    ready: heap,
    postGC: heap,
    workflowPostGC: heap,
    readyRssBytes: 1000 + index * 100,
    postGCRssBytes: 900 + index * 100,
    workflowRssBytes: 1100 + index * 100,
  });
  const runs = (cpuRate) =>
    profilerOrders.map((order, repeat) => ({
      app: "baseline",
      cpuRate,
      repeat,
      order,
      arms: Object.fromEntries(profilerArms.map((arm, index) => [arm, sample(index)])),
    }));
  return {
    schemaVersion: 2,
    experiment: "baseline-profiler-placement",
    sourceFingerprint: "f".repeat(64),
    protocolFingerprint: profilerProtocolFingerprint(),
    browser: "fixture",
    protocol: structuredClone(profilerProtocol),
    environment: {
      react: "19.3.0",
      node: process.version,
      cpu: "fixture",
      platform: "darwin",
      arch: "arm64",
    },
    loadRuns: [...runs(1), ...runs(4)],
    cpuRuns: runs(1),
    memoryRuns: runs(1),
  };
}

test("Baseline placement contrasts retain absolute and percentage CPU/memory overhead", () => {
  assert.deepEqual(profilerApps, ["baseline"]);
  assert.deepEqual(profilerArms, ["production", "profile-tracks", "profile-granular"]);
  const report = analyzeProfiler(measurements());
  assert.equal(report.schemaVersion, 2);
  const root = report.results.find(
    (row) => row.reference === "production" && row.candidate === "profile-tracks",
  );
  const placement = report.results.find(
    (row) => row.reference === "profile-tracks" && row.candidate === "profile-granular",
  );
  assert.equal(
    Number(
      root.endpoints.find((entry) => entry.name === "workflow renderer CPU").percent.toFixed(6),
    ),
    25,
  );
  assert.equal(
    Number(
      placement.endpoints
        .find((entry) => entry.name === "workflow renderer CPU")
        .percent.toFixed(6),
    ),
    20,
  );
  assert.equal(root.endpoints.find((entry) => entry.name === "load readiness 1x").absolute, 10);
  assert.ok(root.endpoints.some((entry) => entry.name === "post-GC renderer RSS"));
  assert.ok(!root.endpoints.some((entry) => /query|domMs|paint|frame/.test(entry.name)));
});

test("placement protocol rejects old schemas, incomplete arms, duplicate and unbalanced trials", () => {
  for (const mutate of [
    (raw) => {
      raw.schemaVersion = 1;
    },
    (raw) => {
      raw.loadRuns[0].app = "compiler";
    },
    (raw) => {
      delete raw.cpuRuns[0].arms["profile-granular"];
    },
    (raw) => {
      raw.cpuRuns[1].repeat = 0;
    },
    (raw) => {
      raw.memoryRuns[0].order.reverse();
    },
    (raw) => {
      raw.memoryRuns[0].arms.production.postGC.usedSize = -1;
    },
    (raw) => {
      raw.cpuRuns[0].arms.production.workflowCpuMs = NaN;
    },
    (raw) => {
      raw.memoryRuns[0].arms.production.postGCRssBytes = null;
    },
    (raw) => {
      raw.protocol.callback = "validating recorder";
    },
    (raw) => {
      raw.cpuRuns[0].arms["profile-granular"].state.rows = 34;
    },
  ]) {
    const raw = structuredClone(measurements());
    mutate(raw);
    assert.throws(() => analyzeProfiler(raw));
  }
});

test("overhead percentages use the selected reference and preserve zero/null cases", () => {
  assert.equal(delta([10, 20, 30], [11, 22, 33]).percent, 10);
  assert.equal(delta([0], [2]).percent, null);
  assert.equal(delta([null], [null]), null);
  assert.equal(delta([2], [1]).absolute, -1);
  assert.throws(() => delta([1, null], [2, null]), /Mixed/);
});

test("renderer CPU uses all-thread cumulative seconds and refuses replaced processes", () => {
  const before = [{ id: 42, type: "renderer", cpuTime: 1 }];
  assert.equal(rendererCpuDelta(before, [{ id: 42, type: "renderer", cpuTime: 1.5 }]), 500);
  assert.throws(
    () => rendererCpuDelta(before, [{ id: 43, type: "renderer", cpuTime: 1.5 }]),
    /identities changed/,
  );
  assert.throws(
    () => rendererCpuDelta(before, [{ id: 42, type: "renderer", cpuTime: 0.5 }]),
    /cumulative/,
  );
});

test("authenticated placement report recomputes raw data and refuses tampering", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "placement-evidence-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const raw = measurements();
  const bundle = {
    js: { raw: 100, gzip: 50 },
    css: { raw: 20, gzip: 10 },
    total: { raw: 120, gzip: 60 },
  };
  const builds = {
    baseline: Object.fromEntries(profilerArms.map((arm) => [arm, { bundle, files: {} }])),
  };
  const report = { ...analyzeProfiler(raw), builds };
  writeFileSync(`${directory}/measurements.json`, JSON.stringify(raw));
  writeFileSync(`${directory}/comparison.json`, JSON.stringify(report));
  writeFileSync(`${directory}/comparison.md`, renderProfiler(report));
  writeFileSync(`${directory}/report.html`, "fixture");
  writeFileSync(
    `${directory}/provenance.json`,
    JSON.stringify({
      schemaVersion: 2,
      sourceFingerprint: raw.sourceFingerprint,
      protocolFingerprint: raw.protocolFingerprint,
      builds,
      artifacts: hashFiles(directory, [
        "measurements.json",
        "comparison.json",
        "comparison.md",
        "report.html",
      ]),
    }),
  );
  assert.equal(readProfilerEvidence(directory, raw.sourceFingerprint).report.results.length, 3);
  writeFileSync(`${directory}/comparison.json`, "{}");
  assert.throws(() => readProfilerEvidence(directory, raw.sourceFingerprint), /artifact changed/);
});

test("tracks distinguish structured component render events from effects", () => {
  const event = (name, start, end, color, track, trackGroup) => ({
    name: "TimeStamp",
    cat: "devtools.timeline",
    ph: "I",
    pid: 1,
    tid: 2,
    ts: end + 1000,
    args: { data: { name, start, end, color, track, trackGroup } },
  });
  const trace = {
    traceEvents: [
      { name: "overhead:start:workflow", cat: "blink.user_timing", ts: 1000, pid: 1, tid: 2 },
      { name: "overhead:end:workflow", cat: "blink.user_timing", ts: 8000, pid: 1, tid: 2 },
      event("Render", 2000, 6000, "primary", "Blocking", "Scheduler \u269b"),
      event("a", 2000, 6000, "primary", "Components \u269b"),
      event("b", 3000, 4000, "primary-light", "Components \u269b"),
      event("b", 5000, 6000, "secondary-light", "Components \u269b"),
    ],
  };
  const result = parseTracks(trace, true);
  assert.equal(result.windows.workflow.renderEvents, 2);
  assert.equal(result.windows.workflow.effectEvents, 1);
  assert.deepEqual(result.windows.workflow.components.a.inclusiveDurationsMs, [4]);
  assert.throws(() => parseTracks(trace, false), /Normal production/);
});

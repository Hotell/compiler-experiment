import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  captureLoadMemory,
  heapFields,
  loadMemoryOrders,
  memoryApps,
  sampleIntervalMs,
  validateHeapUsage,
} from "./load-memory.mjs";
import { analyzeLoadMemory, loadMemoryMarkdown } from "../scripts/load-memory.mjs";

function heap(usedSize = 100, embedderHeapUsedSize = 40) {
  return { usedSize, totalSize: 2000, embedderHeapUsedSize, backingStorageSize: 10 };
}

function fixture() {
  return {
    schemaVersion: 1,
    browser: "test-browser",
    cpuRate: 4,
    viewport: { width: 1440, height: 900 },
    sampleIntervalMs,
    protocol: "Runtime.getHeapUsage",
    isolation: "fresh-browser-per-app-per-repetition",
    cache: "disabled",
    readiness: "200 rows followed by two animation-frame callbacks",
    repetitions: loadMemoryOrders.map((order, repeat) => ({
      repeat,
      order,
      runs: order.map((app) => {
        const factor = app === "compiler" ? 1 : app === "manual" ? 2 : 4;
        const sample = (startedMs, usedSize, embedderHeapUsedSize) => ({
          ...heap(usedSize * factor, embedderHeapUsedSize * factor),
          totalSize: 10000,
          startedMs,
          completedMs: startedMs + 1,
        });
        return {
          app,
          beforeNavigation: sample(0, 900, 900),
          navigationStartedMs: 2,
          loadSamples: [sample(3, 300 + repeat, 70), sample(25, 100, 130)],
          readyObservedMs: 26,
          ready: sample(27, 200, 90),
          postGC: sample(31, 110, 55),
          state: { rows: 200, total: "200", detailOpen: false },
        };
      }),
    })),
  };
}

test("capture polls without forced GC, then records readiness before post-GC memory", async () => {
  let now = 0;
  let reads = 0;
  let finish;
  const readiness = new Promise((resolve) => {
    finish = resolve;
  });
  const events = [];
  const result = await captureLoadMemory({
    clock: () => now,
    readHeap: async () => {
      events.push(`read-${++reads}`);
      now += 2;
      if (reads === 3) finish();
      return heap(reads * 10, reads * 5);
    },
    load: async () => {
      events.push("navigate");
      await readiness;
      events.push("ready");
    },
    collectGarbage: async () => {
      events.push("gc");
      now += 5;
    },
    pause: async (ms) => {
      assert.equal(ms, sampleIntervalMs);
      now += ms;
    },
  });
  assert.equal(result.beforeNavigation.usedSize, 10);
  assert.ok(result.loadSamples.length >= 1);
  assert.equal(result.ready.usedSize, 40);
  assert.equal(result.postGC.usedSize, 50);
  assert.deepEqual(events, [
    "read-1",
    "navigate",
    "read-2",
    "read-3",
    "ready",
    "read-4",
    "gc",
    "read-5",
  ]);
  assert.ok(result.readyObservedMs <= result.ready.startedMs);
  assert.ok(result.postGC.startedMs > result.ready.completedMs);
});

test("capture surfaces failed navigation or counters without taking a success-shaped post-GC snapshot", async () => {
  let gc = 0;
  await assert.rejects(
    captureLoadMemory({
      readHeap: async () => heap(),
      load: async () => {
        throw new Error("navigation failed");
      },
      collectGarbage: async () => {
        gc++;
      },
      pause: async () => {},
    }),
    /navigation failed/,
  );
  assert.equal(gc, 0);
  await assert.rejects(
    captureLoadMemory({
      readHeap: async () => ({ ...heap(), embedderHeapUsedSize: undefined }),
      load: async () => {
        throw new Error("must not start");
      },
      collectGarbage: async () => {
        gc++;
      },
    }),
    /embedderHeapUsedSize/,
  );
  assert.equal(gc, 0);
});

test("all counters must be present, finite nonnegative integer bytes; zero is not missing", () => {
  validateHeapUsage(heap(0, 0));
  for (const field of heapFields) {
    for (const value of [undefined, null, NaN, Infinity, -1, 1.5, "100"]) {
      assert.throws(() => validateHeapUsage({ ...heap(), [field]: value }), new RegExp(field));
    }
  }
  assert.throws(() => validateHeapUsage(heap(2001)), /exceeds allocated/);
});

test("summaries separate phases, exclude blank-page memory and retain independent counter peaks", () => {
  const input = fixture();
  const report = analyzeLoadMemory(input, "test-browser");
  assert.deepEqual(report.apps.compiler.phases.sampledPeak.usedSize, {
    medianBytes: 302.5,
    minBytes: 300,
    maxBytes: 305,
  });
  assert.equal(report.apps.compiler.phases.sampledPeak.embedderHeapUsedSize.medianBytes, 130);
  assert.equal(report.apps.compiler.phases.ready.usedSize.medianBytes, 200);
  assert.equal(report.apps.compiler.phases.postGC.usedSize.medianBytes, 110);
  assert.equal(report.deltas.manual.ready.usedSize.percent, -50);
  assert.equal(report.deltas.baseline.ready.usedSize.percent, -75);
  assert.equal(report.deltas.manual.ready.usedSize.bytes, -200);
  assert.equal(report.apps.compiler.runs.length, 6);
  assert.deepEqual(report.coverage, {
    minLoadSamples: 2,
    maxLoadSamples: 2,
    maxLoadRequestMs: 1,
    maxReadinessLagMs: 2,
  });
  const markdown = loadMemoryMarkdown(report).join("\n");
  assert.match(markdown, /JS heap used/);
  assert.match(markdown, /Embedder heap used/);
  assert.match(markdown, /-50.00%/);
  assert.match(markdown, /not the true allocation peak/);
  assert.match(markdown, /not confidence intervals/);
  assert.match(markdown, /not all native\/DOM memory or total tab\/process memory/);
  assert.match(markdown, /\[Raw load-memory samples\]\(load-memory.json\)/);
});

test("zero reference is explicit and compiler increases are not reported as savings", () => {
  const input = fixture();
  for (const repetition of input.repetitions) {
    for (const run of repetition.runs) {
      run.ready.embedderHeapUsedSize = run.app === "compiler" ? 200 : 0;
      if (run.app === "compiler") run.ready.usedSize = 500;
    }
  }
  const report = analyzeLoadMemory(input, "test-browser");
  assert.equal(report.deltas.manual.ready.embedderHeapUsedSize.percent, null);
  assert.equal(report.deltas.manual.ready.usedSize.percent, 25);
  assert.equal(report.apps.manual.phases.ready.embedderHeapUsedSize.medianBytes, 0);
  assert.match(loadMemoryMarkdown(report).join("\n"), /n\/a \(zero reference\)/);
  assert.match(loadMemoryMarkdown(report).join("\n"), /\+25.00%/);
});

test("each implementation occupies each load-order position twice", () => {
  assert.equal(new Set(loadMemoryOrders.map((order) => order.join(","))).size, 6);
  for (const app of memoryApps) {
    for (const position of [0, 1, 2]) {
      assert.equal(loadMemoryOrders.filter((order) => order[position] === app).length, 2);
    }
  }
});

test("missing fields, mismatched designs and invalid snapshot ordering fail closed", () => {
  const mutations = [
    (input) => {
      delete input.schemaVersion;
    },
    (input) => {
      input.browser = "different";
    },
    (input) => {
      input.cpuRate = 1;
    },
    (input) => {
      input.cache = "enabled";
    },
    (input) => {
      input.repetitions.pop();
    },
    (input) => {
      input.repetitions[0].runs.pop();
    },
    (input) => {
      input.repetitions[0].order = ["manual", "compiler", "baseline"];
    },
    (input) => {
      input.repetitions[0].runs[0].loadSamples = [];
    },
    (input) => {
      input.repetitions[0].runs[0].readyObservedMs = Infinity;
    },
    (input) => {
      input.repetitions[0].runs[0].readyObservedMs = 100;
    },
    (input) => {
      input.repetitions[0].runs[0].readyObservedMs = 10;
    },
    (input) => {
      input.repetitions[0].runs[0].postGC.startedMs = 1;
    },
    (input) => {
      input.repetitions[0].runs[0].ready.embedderHeapUsedSize = undefined;
    },
    (input) => {
      input.repetitions[0].runs[0].state.rows = 199;
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => analyzeLoadMemory(input, "test-browser"));
  }
});

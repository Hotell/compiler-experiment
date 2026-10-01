import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";

/** @typedef {{usedSize: number, totalSize: number, embedderHeapUsedSize: number, backingStorageSize: number}} HeapUsage */
/** @typedef {HeapUsage & {startedMs: number, completedMs: number}} HeapSample */
export const heapFields = ["usedSize", "totalSize", "embedderHeapUsedSize", "backingStorageSize"];
export const memoryApps = ["compiler", "manual", "baseline"];
export const loadMemoryOrders = [
  ["compiler", "manual", "baseline"],
  ["manual", "baseline", "compiler"],
  ["baseline", "compiler", "manual"],
  ["baseline", "manual", "compiler"],
  ["manual", "compiler", "baseline"],
  ["compiler", "baseline", "manual"],
];
export const sampleIntervalMs = 20;

/** @param {HeapUsage} usage */
export function validateHeapUsage(usage) {
  for (const field of heapFields) {
    assert.ok(
      Number.isSafeInteger(usage?.[field]) && usage[field] >= 0,
      `Runtime.getHeapUsage requires nonnegative byte counter ${field}; check the Chromium version`,
    );
  }
  assert.ok(usage.usedSize <= usage.totalSize, "Used JS heap exceeds allocated JS heap");
}

/**
 * @param {{
 *   readHeap: () => Promise<HeapUsage>,
 *   load: () => Promise<void>,
 *   collectGarbage: () => Promise<void>,
 *   clock?: () => number,
 *   pause?: (ms: number) => Promise<unknown>
 * }} options
 */
export async function captureLoadMemory({
  readHeap,
  load,
  collectGarbage,
  clock = () => performance.now(),
  pause = delay,
}) {
  const start = clock();
  const now = () => clock() - start;
  async function sample() {
    const startedMs = now();
    const usage = await readHeap();
    const completedMs = now();
    validateHeapUsage(usage);
    return {
      startedMs,
      completedMs,
      usedSize: usage.usedSize,
      totalSize: usage.totalSize,
      embedderHeapUsedSize: usage.embedderHeapUsedSize,
      backingStorageSize: usage.backingStorageSize,
    };
  }

  const beforeNavigation = await sample();
  const navigationStartedMs = now();
  /** @type {HeapSample[]} */
  const loadSamples = [];
  /** @type {number | undefined} */
  let readyObservedMs;
  let stopped = false;
  const loading = load()
    .then(() => {
      readyObservedMs = now();
    })
    .finally(() => {
      stopped = true;
    });
  async function poll() {
    try {
      while (!stopped) {
        loadSamples.push(await sample());
        if (!stopped) await Promise.race([pause(sampleIntervalMs), loading]);
      }
    } finally {
      stopped = true;
    }
  }
  try {
    await Promise.all([loading, poll()]);
  } finally {
    stopped = true;
  }
  assert.ok(readyObservedMs !== undefined, "Load readiness was not observed");
  assert.ok(loadSamples.length > 0, "No heap samples collected during navigation");
  const ready = await sample();
  await collectGarbage();
  const postGC = await sample();
  return { beforeNavigation, navigationStartedMs, readyObservedMs, loadSamples, ready, postGC };
}

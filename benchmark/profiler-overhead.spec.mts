import { test, expect, chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { resultsDirectory } from "../scripts/benchmark-results.mjs";
import { sourceFingerprint, hashFiles } from "../scripts/benchmark-provenance.mjs";
import {
  parseTracks,
  profilerBuilds,
  profilerProtocol,
  profilerProtocolFingerprint,
  profilerOrders,
  rendererCpuDelta,
  sha256,
} from "../scripts/profiler-overhead.mjs";
import { captureLoadMemory } from "./load-memory.mjs";

const arms = ["production", "profile-tracks", "profile-granular"] as const;
type Arm = (typeof arms)[number];
const directory = `${resultsDirectory()}/profiler-overhead`;
const origin = (arm: Arm) => `http://127.0.0.1:${4575 + arms.indexOf(arm) * 100}`;
type ResourceRun = {
  app: string;
  cpuRate: number;
  repeat: number;
  order: Arm[];
  arms: Record<Arm, unknown>;
};
declare global {
  interface Window {
    __profilerLoadReady?: number;
  }
}

test.beforeAll(async ({ request }) => {
  const builds = profilerBuilds().baseline;
  for (const arm of arms)
    for (const [file, hash] of Object.entries(builds[arm].files)) {
      const response = await request.get(`${origin(arm)}/${file}`);
      expect(response.ok()).toBe(true);
      expect(sha256(await response.body())).toBe(hash);
    }
});

async function assertClean(page: Page) {
  expect(
    await page.evaluate(() =>
      [
        "__benchmark",
        "__fiberBenchmark",
        "__REACT_SCAN__",
        "__REACT_DEVTOOLS_GLOBAL_HOOK__",
      ].filter((name) => name in window),
    ),
  ).toEqual([]);
  await expect(page.locator("#react-scan-root")).toHaveCount(0);
}

async function prepare(browser: Browser, arm: Arm, cpuRate = 1) {
  const context = await browser.newContext({ viewport: profilerProtocol.viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/react-scan/.test(request.url())) errors.push("Scan request");
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.addInitScript(() => {
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending || document.querySelectorAll("tbody tr").length !== 200) return;
      pending = true;
      observer.disconnect();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.__profilerLoadReady = performance.now();
        }),
      );
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  async function load() {
    await page.bringToFront();
    expect((await page.goto(origin(arm), { waitUntil: "commit" }))?.status()).toBe(200);
    await page.waitForFunction(() => Number.isFinite(window.__profilerLoadReady), undefined, {
      timeout: 30000,
    });
  }
  async function check() {
    await assertClean(page);
    expect(errors).toEqual([]);
  }
  return { page, cdp, context, load, check };
}

async function state(page: Page) {
  return page.evaluate(() => ({
    rows: document.querySelectorAll("tbody tr").length,
    ids: Array.from(document.querySelectorAll("tbody .incident-id"), (node) =>
      node.textContent?.trim(),
    ),
    search: (document.querySelector('[aria-label="Search incidents"]') as HTMLInputElement).value,
    selected: document.querySelector("tbody tr.selected .incident-id")?.textContent?.trim() ?? null,
    favorite: document.querySelector('[aria-label="Unfavorite INC-0001"]') !== null,
    activityItems: document.querySelectorAll('[aria-label="Incident detail"] .activity-list li')
      .length,
  }));
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function workflow(page: Page, cycles: number) {
  await page.bringToFront();
  for (let cycle = 0; cycle < cycles; cycle++) {
    await page.getByRole("button", { name: "Open INC-0001", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("INC-0001");
    await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Favorite INC-0001", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Close detail", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search incidents" });
    await search.pressSequentially("API", { delay: profilerProtocol.workflow.minimumKeyDelayMs });
    await expect(page.locator("tbody tr")).toHaveCount(34);
    await search.fill("");
    await expect(page.locator("tbody tr")).toHaveCount(200);
    await frames(page);
  }
}

async function heap(cdp: CDPSession) {
  const value = await cdp.send("Runtime.getHeapUsage");
  return {
    usedSize: value.usedSize,
    totalSize: value.totalSize,
    embedderHeapUsedSize: value.embedderHeapUsedSize!,
    backingStorageSize: value.backingStorageSize!,
  };
}

async function rendererCounters(session: CDPSession) {
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const renderers = processInfo
    .filter((entry) => entry.type === "renderer")
    .sort((left, right) => left.id - right.id);
  expect(renderers.length).toBeGreaterThan(0);
  return renderers;
}

async function rendererRss(session: CDPSession) {
  const processes = await rendererCounters(session);
  let bytes: number;
  if (platform() === "linux")
    bytes = processes.reduce((total, entry) => {
      const statusText = readFileSync(`/proc/${entry.id}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
      if (!rss) throw new Error(`Missing VmRSS for renderer ${entry.id}`);
      return total + Number(rss[1]) * 1024;
    }, 0);
  else if (platform() === "darwin") {
    const rss = execFileSync(
      "ps",
      ["-o", "rss=", "-p", processes.map((entry) => entry.id).join(",")],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(rss.length).toBe(processes.length);
    bytes = rss.reduce((sum, value) => sum + value * 1024, 0);
  } else throw new Error("Renderer RSS collection supports Linux and macOS only");
  expect(Number.isSafeInteger(bytes) && bytes > 0).toBe(true);
  return { bytes, processIds: processes.map((entry) => entry.id) };
}

test("placement topology and workload smoke", async ({ browser }) => {
  test.skip(process.env.PROFILER_TRACKS === "1");
  test.setTimeout(90000);
  const outcomes = [];
  for (const arm of arms) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(() =>
        Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot(_renderer: number, root: { current: unknown }) {
            type Fiber = {
              tag: number;
              memoizedProps?: { id?: string };
              child?: Fiber;
              sibling?: Fiber;
            };
            const ids: string[] = [];
            function visit(fiber?: Fiber) {
              for (let node = fiber; node; node = node.sibling) {
                if (node.tag === 12) ids.push(node.memoizedProps?.id ?? "missing");
                visit(node.child);
              }
            }
            visit(root.current as Fiber);
            Reflect.set(window, "__placementIds", ids);
          },
        }),
      );
      await page.goto(origin(arm));
      await expect(page.locator("tbody tr")).toHaveCount(200);
      const ids = await page.evaluate(() => Reflect.get(window, "__placementIds") as string[]);
      if (arm === "production") expect(ids).toEqual([]);
      else if (arm === "profile-tracks") expect(ids).toEqual(["root"]);
      else {
        const expected = [
          "root",
          "shell",
          "toolbar",
          "list",
          "detail",
          ...["All incidents", "Platform", "Payments", "Identity"].map((queue) => `queue:${queue}`),
          ...Array.from(
            { length: 200 },
            (_, index) => `INC-${String(index + 1).padStart(4, "0")}`,
          ).flatMap((id) => [`row:${id}`, `button:open:${id}`, `button:favorite:${id}`]),
        ];
        expect([...ids].sort()).toEqual(expected.sort());
      }
      expect(await page.evaluate(() => "__benchmark" in window)).toBe(false);
    } finally {
      await context.close();
    }
    const run = await prepare(browser, arm);
    try {
      await run.load();
      await workflow(run.page, 1);
      await run.check();
      outcomes.push(await state(run.page));
    } finally {
      await run.context.close();
    }
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[2]).toEqual(outcomes[0]);
});

test("Baseline placement load CPU and memory without traces", async ({ browser }) => {
  test.skip(process.env.PROFILER_TRACKS === "1");
  test.setTimeout(1200000);
  const fingerprint = sourceFingerprint(),
    protocolFingerprint = profilerProtocolFingerprint();
  const builds = JSON.parse(readFileSync(`${directory}/builds.json`, "utf8"));
  expect(profilerBuilds()).toEqual(builds);
  const loadRuns: ResourceRun[] = [],
    cpuRuns: ResourceRun[] = [],
    memoryRuns: ResourceRun[] = [];
  for (const cpuRate of profilerProtocol.loadCpuRates)
    for (const [repeat, values] of profilerOrders.entries()) {
      const order = values as Arm[],
        samples = {} as Record<Arm, unknown>;
      for (const arm of order) {
        const isolated = await chromium.launch();
        try {
          expect(isolated.version()).toBe(browser.version());
          const run = await prepare(isolated, arm, cpuRate);
          await run.load();
          samples[arm] = {
            upltMs: await run.page.evaluate(() => window.__profilerLoadReady!),
            state: await state(run.page),
          };
          await run.check();
        } finally {
          await isolated.close();
        }
      }
      loadRuns.push({ app: "baseline", cpuRate, repeat, order, arms: samples });
      console.log(`load ${cpuRate}x permutation ${repeat + 1}/6 complete`);
    }
  for (const kind of ["cpu", "memory"] as const)
    for (const [repeat, values] of profilerOrders.entries()) {
      const order = values as Arm[],
        samples = {} as Record<Arm, unknown>;
      for (const arm of order) {
        const isolated = await chromium.launch();
        try {
          expect(isolated.version()).toBe(browser.version());
          const run = await prepare(isolated, arm);
          const processSession = await isolated.newBrowserCDPSession();
          if (kind === "cpu") {
            const beforeLoad = await rendererCounters(processSession);
            await run.load();
            const afterLoad = await rendererCounters(processSession);
            await workflow(run.page, profilerProtocol.workflow.warmups);
            const beforeWorkflow = await rendererCounters(processSession);
            await workflow(run.page, profilerProtocol.workflow.cycles);
            const afterWorkflow = await rendererCounters(processSession);
            samples[arm] = {
              loadCpuMs: rendererCpuDelta(beforeLoad, afterLoad),
              workflowCpuMs: rendererCpuDelta(beforeWorkflow, afterWorkflow),
              processCounters: { beforeLoad, afterLoad, beforeWorkflow, afterWorkflow },
              state: await state(run.page),
            };
          } else {
            let readyRss: Awaited<ReturnType<typeof rendererRss>> | undefined;
            const memory = await captureLoadMemory({
              readHeap: () => heap(run.cdp),
              load: run.load,
              collectGarbage: async () => {
                readyRss = await rendererRss(processSession);
                await run.cdp.send("HeapProfiler.collectGarbage");
              },
            });
            if (!readyRss) throw new Error("Readiness RSS snapshot was not captured before GC");
            const postGCRss = await rendererRss(processSession);
            await workflow(run.page, profilerProtocol.workflow.warmups);
            await workflow(run.page, profilerProtocol.workflow.cycles);
            await run.cdp.send("HeapProfiler.collectGarbage");
            const workflowPostGC = await heap(run.cdp),
              workflowRss = await rendererRss(processSession);
            samples[arm] = {
              ...memory,
              workflowPostGC,
              readyRssBytes: readyRss.bytes,
              postGCRssBytes: postGCRss.bytes,
              workflowRssBytes: workflowRss.bytes,
              rssProcessIds: {
                ready: readyRss.processIds,
                postGC: postGCRss.processIds,
                workflow: workflowRss.processIds,
              },
              state: await state(run.page),
            };
          }
          await run.check();
        } finally {
          await isolated.close();
        }
      }
      const result = { app: "baseline", cpuRate: 1, repeat, order, arms: samples };
      (kind === "cpu" ? cpuRuns : memoryRuns).push(result);
      console.log(`${kind} permutation ${repeat + 1}/6 complete`);
    }
  expect(sourceFingerprint()).toBe(fingerprint);
  expect(profilerProtocolFingerprint()).toBe(protocolFingerprint);
  expect(profilerBuilds()).toEqual(builds);
  mkdirSync(directory, { recursive: true });
  const dependencies = JSON.parse(readFileSync("package.json", "utf8")).devDependencies;
  writeFileSync(
    `${directory}/measurements.json`,
    JSON.stringify({
      schemaVersion: 2,
      experiment: "baseline-profiler-placement",
      sourceFingerprint: fingerprint,
      protocolFingerprint,
      browser: browser.version(),
      protocol: profilerProtocol,
      environment: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unavailable",
        node: process.version,
        react: dependencies.react,
        dependencies,
        lockfile: sha256(readFileSync("yarn.lock")),
      },
      loadRuns,
      cpuRuns,
      memoryRuns,
    }),
  );
});

test("offline Baseline placement performance tracks", async ({ browser }) => {
  test.skip(process.env.PROFILER_TRACKS !== "1");
  test.setTimeout(90000);
  const fingerprint = sourceFingerprint(),
    protocolFingerprint = profilerProtocolFingerprint(),
    builds = profilerBuilds();
  const summaries = {} as Record<Arm, ReturnType<typeof parseTracks>>;
  mkdirSync(`${directory}/traces`, { recursive: true });
  for (const arm of arms) {
    const context = await browser.newContext({ viewport: profilerProtocol.viewport });
    try {
      const page = await context.newPage(),
        cdp = await context.newCDPSession(page);
      await page.addInitScript(() => performance.mark("overhead:start:load"));
      const events: unknown[] = [];
      cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,blink.user_timing,v8.execute",
        transferMode: "ReportEvents",
      });
      await page.goto(origin(arm));
      await expect(page.locator("tbody tr")).toHaveCount(200);
      await frames(page);
      await page.evaluate(() => performance.mark("overhead:end:load"));
      await assertClean(page);
      await page.evaluate(() => performance.mark("overhead:start:workflow"));
      await workflow(page, 1);
      await page.evaluate(() => performance.mark("overhead:end:workflow"));
      await assertClean(page);
      const complete = new Promise<void>((resolve) =>
        cdp.once("Tracing.tracingComplete", () => resolve()),
      );
      await cdp.send("Tracing.end");
      await complete;
      const trace = { traceEvents: events };
      summaries[arm] = parseTracks(trace, arm !== "production");
      if (arm !== "production")
        for (const name of ["load", "workflow"])
          expect(
            (summaries[arm].windows as Record<string, { renderEvents: number }>)[name].renderEvents,
          ).toBeGreaterThan(0);
      writeFileSync(`${directory}/traces/baseline-${arm}.json`, JSON.stringify(trace));
    } finally {
      await context.close();
    }
  }
  expect(sourceFingerprint()).toBe(fingerprint);
  expect(profilerProtocolFingerprint()).toBe(protocolFingerprint);
  expect(profilerBuilds()).toEqual(builds);
  writeFileSync(
    `${directory}/component-work.json`,
    JSON.stringify({
      schemaVersion: 2,
      sourceFingerprint: fingerprint,
      protocolFingerprint,
      browser: browser.version(),
      builds,
      files: hashFiles(
        directory,
        arms.map((arm) => `traces/baseline-${arm}.json`),
      ),
      apps: { baseline: summaries },
    }),
  );
});

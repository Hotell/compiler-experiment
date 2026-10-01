import { test, expect, chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { captureLoadMemory, loadMemoryOrders, sampleIntervalMs } from "./load-memory.mjs";

const origins: Record<string, string> = {
  compiler: "http://127.0.0.1:4273",
  manual: "http://127.0.0.1:4274",
  baseline: "http://127.0.0.1:4275",
};

test.use({ trace: "off" });

test("load-time JS and embedder heaps in isolated normal-production browsers", async () => {
  test.setTimeout(180000);
  const repetitions = [];
  let browserVersion: string | undefined;
  for (const [repeat, order] of loadMemoryOrders.entries()) {
    const runs = [];
    for (const app of order) {
      const browser = await chromium.launch();
      try {
        if (browserVersion) expect(browser.version()).toBe(browserVersion);
        browserVersion = browser.version();
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Runtime.enable");
        await cdp.send("Runtime.addBinding", { name: "__loadMemoryReady" });
        await page.addInitScript(() => {
          let pending = false;
          const observer = new MutationObserver(() => {
            if (pending || document.querySelectorAll("tbody tr").length !== 200) return;
            pending = true;
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const binding = Reflect.get(window, "__loadMemoryReady");
                if (typeof binding !== "function")
                  throw new Error("Load-memory readiness binding missing");
                binding("ready");
              }),
            );
          });
          observer.observe(document, { childList: true, subtree: true });
        });
        const measurement = await captureLoadMemory({
          readHeap: () => cdp.send("Runtime.getHeapUsage"),
          load: async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const ready = new Promise<void>((resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `${app}: load-memory readiness timed out; page errors: ${errors.join("; ") || "none"}`,
                    ),
                  ),
                30000,
              );
              cdp.on("Runtime.bindingCalled", ({ name }) => {
                if (name === "__loadMemoryReady") resolve();
              });
            });
            try {
              const [response] = await Promise.all([
                page.goto(origins[app], { waitUntil: "commit" }),
                ready,
              ]);
              expect(response?.status()).toBe(200);
            } finally {
              clearTimeout(timer);
            }
          },
          collectGarbage: async () => {
            await cdp.send("HeapProfiler.collectGarbage");
          },
        });
        const state = await page.evaluate(() => ({
          rows: document.querySelectorAll("tbody tr").length,
          total: document.querySelector('[data-testid="total"]')?.textContent?.trim(),
          detailOpen: document.querySelector("dialog.detail-open") !== null,
        }));
        expect(state).toEqual({ rows: 200, total: "200", detailOpen: false });
        expect(await page.evaluate(() => "__benchmark" in window)).toBe(false);
        expect(await page.evaluate(() => "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window)).toBe(false);
        expect(errors).toEqual([]);
        runs.push({ app, ...measurement, state });
      } finally {
        await browser.close();
      }
    }
    repetitions.push({ repeat, order, runs });
  }
  mkdirSync("benchmark/results", { recursive: true });
  writeFileSync(
    "benchmark/results/load-memory.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        browser: browserVersion,
        cpuRate: 4,
        viewport: { width: 1440, height: 900 },
        sampleIntervalMs,
        protocol: "Runtime.getHeapUsage",
        isolation: "fresh-browser-per-app-per-repetition",
        cache: "disabled",
        readiness: "200 rows followed by two animation-frame callbacks",
        repetitions,
      },
      null,
      2,
    ),
  );
});

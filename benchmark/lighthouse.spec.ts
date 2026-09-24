import { test, expect, chromium } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";
import { mkdirSync, writeFileSync } from "node:fs";

const directory = "benchmark/results";
const origins = { compiler: "http://127.0.0.1:4273", manual: "http://127.0.0.1:4274" } as const;
type AppName = keyof typeof origins;

test("Lighthouse mobile audits of normal production builds", async () => {
  test.setTimeout(300000);
  mkdirSync(directory, { recursive: true });
  const repetitions: Record<AppName, object>[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = {} as Record<AppName, object>;
    const order: AppName[] = repeat % 2 ? ["manual", "compiler"] : ["compiler", "manual"];
    for (const app of order) {
      const chrome = await launch({
        chromePath: chromium.executablePath(),
        chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const result = await lighthouse(origins[app], {
          port: chrome.port,
          output: "json",
          onlyCategories: ["performance", "accessibility"],
          logLevel: "error",
        });
        expect(result?.lhr.runtimeError).toBeUndefined();
        const lhr = result!.lhr;
        const metric = (key: string) => lhr.audits[key]?.numericValue ?? null;
        results[app] = {
          performanceScore: Math.round((lhr.categories.performance.score ?? 0) * 100),
          accessibilityScore: Math.round((lhr.categories.accessibility.score ?? 0) * 100),
          fcpMs: metric("first-contentful-paint"),
          lcpMs: metric("largest-contentful-paint"),
          tbtMs: metric("total-blocking-time"),
          speedIndexMs: metric("speed-index"),
          cls: metric("cumulative-layout-shift"),
          interactiveMs: metric("interactive"),
          version: lhr.lighthouseVersion,
          settings: lhr.configSettings,
        };
        expect(metric("first-contentful-paint")).toBeGreaterThan(0);
        expect(metric("largest-contentful-paint")).toBeGreaterThan(0);
        if (repeat === 0) writeFileSync(`${directory}/lighthouse-${app}.json`, JSON.stringify(lhr));
      } finally {
        await chrome.kill();
      }
    }
    repetitions.push(results);
  }
  writeFileSync(`${directory}/lighthouse.json`, JSON.stringify({ repetitions }, null, 2));
});

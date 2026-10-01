import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFiberRecorder } from "./fiber-recorder";
import { filteringProtocol, filteringResultIds } from "./filtering.mjs";
import { loadMemoryOrders } from "./load-memory.mjs";
import {
  beginActionWindow,
  collectActionSnapshot,
  type ActionSample,
  type CollectionResult,
  type Outcome,
} from "./collection";

const directory = "benchmark/results";
const origins = {
  compiler: "http://127.0.0.1:4173",
  manual: "http://127.0.0.1:4174",
  baseline: "http://127.0.0.1:4175",
} as const;
const productionOrigins = {
  compiler: "http://127.0.0.1:4273",
  manual: "http://127.0.0.1:4274",
  baseline: "http://127.0.0.1:4275",
} as const;
type AppName = keyof typeof origins;
const apps: AppName[] = ["compiler", "manual", "baseline"];
type Action = ActionSample & { name: string };

async function installFiberRecorder(page: Page) {
  await page.addInitScript({
    content: `window.__fiberBenchmark = (${createFiberRecorder.toString()})(() => window.__benchmark);
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__fiberBenchmark.hook;`,
  });
}

async function snapshot(page: Page, outcome: Outcome, allowNoCommit = false, afterSerial?: number) {
  let sample: ActionSample | undefined;
  await expect
    .poll(async () => {
      const collected: CollectionResult = await page.evaluate(collectActionSnapshot, {
        outcome,
        allowNoCommit,
        afterSerial,
      });
      if (collected.status === "complete") sample = collected.sample;
      return collected.status === "complete" ? "complete" : collected.reason;
    })
    .toBe("complete");
  if (!sample) throw new Error("Action snapshot did not complete");
  return sample;
}

async function operation(page: Page, change: () => Promise<unknown>, outcome: Outcome) {
  const before = await page.evaluate(() => window.__benchmark!.serial);
  await change();
  await snapshot(page, outcome, false, before);
}

async function action(
  page: Page,
  name: string,
  change: () => Promise<Outcome>,
  allowNoCommit = false,
): Promise<Action> {
  await page.evaluate(beginActionWindow);
  const outcome = await change();
  return { name, ...(await snapshot(page, outcome, allowNoCommit)) };
}

async function scenario(page: Page, trace: boolean) {
  await expect(page.getByRole("heading", { name: "Incident triage" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(201);
  await expect(
    page.getByRole("navigation", { name: "Incident queues" }).locator("svg"),
  ).toHaveCount(4);
  const initial = await snapshot(page, { rows: 200, total: "200", reviews: "0" });
  const mounts = initial.records.filter((record) => record.phase === "mount");
  const actions: Action[] = [];
  actions.push(
    await action(page, "header review", async () => {
      await page.getByRole("button", { name: "Add review" }).click();
      await expect(page.getByTestId("reviews")).toHaveText("1");
      return { reviews: "1" };
    }),
  );
  expect(
    actions[0].records.filter((record) => record.phase !== "mount" && record.id.startsWith("row:")),
  ).toHaveLength(0);
  actions.push(
    await action(page, "switch queue", async () => {
      await page
        .getByRole("navigation", { name: "Incident queues" })
        .getByRole("button", { name: "Platform" })
        .click();
      await expect(page.getByTestId("total")).toHaveText("67");
      await expect(page.getByRole("row")).toHaveCount(68);
      return { total: "67", rows: 67, queue: "Platform" };
    }),
  );
  expect(
    actions[1].records.some((record) => record.id.startsWith("queue:") && record.phase !== "mount"),
  ).toBe(true);
  actions.push(
    await action(page, "select incident", async () => {
      await page.getByRole("button", { name: "Open INC-0001" }).click();
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("INC-0001");
      return { detailIncludes: "INC-0001" };
    }),
  );
  let cdp: Awaited<ReturnType<Browser["newBrowserCDPSession"]>> | undefined;
  if (trace) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  actions.push(
    await action(page, "favorite incident", async () => {
      await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      return { favorite: true, detailIncludes: "Favorite changed" };
    }),
  );
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(
      `${directory}/favorite-${new URL(page.url()).port}.cpuprofile`,
      JSON.stringify(profile),
    );
    await cdp.detach();
  }
  const changed = actions
    .at(-1)!
    .records.filter((record) => record.id === "row:INC-0001" && record.phase !== "mount");
  expect(changed.length, "Favorite edit must produce a measured row update").toBeGreaterThan(0);
  const favoriteButtonUpdates = actions
    .at(-1)!
    .records.filter(
      (record) => record.id === "button:favorite:INC-0001" && record.phase !== "mount",
    );
  expect(
    favoriteButtonUpdates.length,
    "Favorite edit must produce a measured button update",
  ).toBeGreaterThan(0);
  actions.push(
    await action(page, "search", async () => {
      await page.getByRole("textbox", { name: "Search incidents" }).fill("INC-0001");
      await expect(page.getByTestId("total")).toHaveText("1");
      await expect(page.getByRole("row")).toHaveCount(2);
      return { search: "INC-0001", total: "1", rows: 1 };
    }),
  );
  actions.push(
    await action(page, "filter status", async () => {
      await page.getByRole("combobox", { name: "Status" }).selectOption("Open");
      await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("Open");
      await expect(page.getByRole("row")).toHaveCount(2);
      return { status: "Open", total: "1", rows: 1 };
    }),
  );
  actions.push(
    await action(page, "sort and reset", async () => {
      await operation(
        page,
        () => page.getByRole("combobox", { name: "Sort" }).selectOption("severity"),
        { sort: "severity", rows: 1 },
      );
      await operation(
        page,
        () => page.getByRole("textbox", { name: "Search incidents" }).fill(""),
        { search: "", total: "67", rows: 67 },
      );
      await operation(
        page,
        () => page.getByRole("combobox", { name: "Status" }).selectOption("All statuses"),
        { status: "All statuses", total: "67", rows: 67 },
      );
      await operation(
        page,
        () =>
          page
            .getByRole("navigation", { name: "Incident queues" })
            .getByRole("button", { name: "All incidents" })
            .click(),
        { queue: "All incidents", total: "200", rows: 200 },
      );
      return {
        sort: "severity",
        search: "",
        status: "All statuses",
        queue: "All incidents",
        total: "200",
        rows: 200,
      };
    }),
  );
  actions.push(
    await action(page, "resolve incident", async () => {
      await page.getByRole("button", { name: "Mark resolved" }).click();
      await expect(page.getByTestId("open-count")).toHaveText("66");
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("Resolved");
      return { openCount: "66", detailIncludes: "Incident resolved" };
    }),
  );
  return { mounts: mounts.length, actions };
}

async function runFiltering(browser: Browser, app: AppName) {
  const context = await browser.newContext({ viewport: filteringProtocol.viewport });
  try {
    const page = await context.newPage();
    await installFiberRecorder(page);
    await page.goto(origins[app]);
    await expect(page.getByRole("row")).toHaveCount(201);
    const initial = await snapshot(page, filteringProtocol.initialState);
    expect(await page.locator("tbody .incident-id").allTextContents()).toEqual(
      filteringProtocol.initialIds,
    );
    const actions = [];
    for (const step of filteringProtocol.steps) {
      const measured = await action(page, step.name, async () => {
        const input = page.getByRole("textbox", { name: "Search incidents" });
        if (step.query)
          await input.pressSequentially(step.query.at(-1)!, {
            delay: filteringProtocol.minimumKeyDelayMs,
          });
        else await input.fill("");
        await expect(page.getByTestId("total")).toHaveText(String(step.rows));
        await expect(page.getByRole("row")).toHaveCount(step.rows + 1);
        expect(await page.locator("tbody .incident-id").allTextContents()).toEqual(
          filteringResultIds(step.query),
        );
        return {
          search: step.query,
          rows: step.rows,
          total: String(step.rows),
          detailIncludes: "No incident selected",
        };
      });
      const resultIds = await page.locator("tbody .incident-id").allTextContents();
      actions.push({ ...measured, ...step, resultIds });
    }
    const remounts = actions
      .at(-1)!
      .records.filter((record) => record.phase === "mount" && record.id.startsWith("row:"));
    expect(remounts).toHaveLength(166);
    return {
      initialState: filteringProtocol.initialState,
      mounts: initial.records.length,
      actions,
    };
  } finally {
    await context.close();
  }
}

async function run(browser: Browser, app: AppName, trace = false, screenshot = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await installFiberRecorder(page);
    await page.goto(origins[app]);
    if (screenshot) {
      await expect(page.getByRole("heading", { name: "Incident triage" })).toBeVisible();
      await page.screenshot({ path: `${directory}/${app}-desktop.png` });
    }
    const workflow = await scenario(page, trace);
    return { ...workflow, paths: { filtering: await runFiltering(browser, app) } };
  } finally {
    await context.close();
  }
}

test("matched incident workflows and profiling recorder", async ({ browser }) => {
  test.setTimeout(180000);
  mkdirSync(directory, { recursive: true });
  for (const app of apps) await run(browser, app, false, true);
  const repetitions = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = {} as Record<AppName, Awaited<ReturnType<typeof run>>>;
    const order = [...apps.slice(repeat), ...apps.slice(0, repeat)];
    for (const app of order)
      results[app] = await run(browser, app, Boolean(process.env.BENCHMARK_TRACE) && repeat === 0);
    expect(results.compiler.actions.map((entry) => entry.state)).toEqual(
      results.manual.actions.map((entry) => entry.state),
    );
    expect(results.compiler.actions.map((entry) => entry.state)).toEqual(
      results.baseline.actions.map((entry) => entry.state),
    );
    for (const app of apps) {
      expect(results[app].paths.filtering.actions.map((entry) => entry.state)).toEqual(
        results.baseline.paths.filtering.actions.map((entry) => entry.state),
      );
    }
    const selectedRowRenders = (app: AppName) =>
      results[app].actions
        .find((entry) => entry.name === "select incident")!
        .fiberRenders.filter((id) => id.startsWith("row:")).length;
    for (const app of apps)
      expect(
        selectedRowRenders(app),
        `${app} selection must record the changed row`,
      ).toBeGreaterThan(0);
    expect(selectedRowRenders("baseline")).toBeGreaterThan(selectedRowRenders("manual"));
    const selectedOpenButtons = (app: AppName) =>
      results[app].actions
        .find((entry) => entry.name === "select incident")!
        .records.filter(
          (record) => record.id.startsWith("button:open:") && record.phase !== "mount",
        ).length;
    expect(selectedOpenButtons("baseline")).toBeGreaterThan(selectedOpenButtons("manual"));
    repetitions.push(results);
  }
  let mobileState: string | undefined;
  for (const app of apps) {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await mobile.newPage();
      await page.goto(origins[app]);
      await page.getByRole("button", { name: "Open INC-0001" }).click();
      const dialog = page.getByRole("dialog", { name: "Incident detail" });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused();
      const state = await dialog.innerText();
      if (mobileState) expect(state).toBe(mobileState);
      mobileState = state;
      await page.screenshot({ path: `${directory}/${app}-mobile.png` });
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByRole("button", { name: "Mark resolved" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Open INC-0001" })).toBeFocused();
    } finally {
      await mobile.close();
    }
  }
  writeFileSync(
    `${directory}/measurements.json`,
    JSON.stringify({ schemaVersion: 2, repetitions, browser: browser.version() }, null, 2),
  );
});

test("profile boundary coverage, no-op windows and remount lifetimes", async ({ browser }) => {
  for (const app of apps) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await installFiberRecorder(page);
      await page.goto(origins[app]);
      await expect(page.getByRole("row")).toHaveCount(201);
      const initial = await snapshot(page, { rows: 200, reviews: "0" });
      const visibleIds = await page.locator("tbody .incident-id").allTextContents();
      const persistent = ["root", "shell", "toolbar", "list", "detail"];
      const expected = [
        ...persistent,
        ...["All incidents", "Platform", "Payments", "Identity"].map((queue) => `queue:${queue}`),
        ...visibleIds.flatMap((id) => [`row:${id}`, `button:open:${id}`, `button:favorite:${id}`]),
      ];
      expect(initial.records.map((record) => record.id).sort()).toEqual(expected.sort());
      expect(initial.records.every((record) => record.phase === "mount")).toBe(true);
      expect(initial.fiberCommits).toHaveLength(1);
      expect(initial.fiberRenders).toEqual([]);

      const noop = await action(
        page,
        "unchanged queue",
        async () => {
          await page
            .getByRole("navigation", { name: "Incident queues" })
            .getByRole("button", { name: "All incidents" })
            .click();
          return { queue: "All incidents", total: "200", rows: 200 };
        },
        true,
      );
      expect(noop.records).toEqual([]);
      expect(noop.fiberCommits).toEqual([]);
      expect(noop.fiberRenders).toEqual([]);

      const review = await action(page, "provider update", async () => {
        await page.getByRole("button", { name: "Add review" }).click();
        await expect(page.getByTestId("reviews")).toHaveText("1");
        return { reviews: "1" };
      });
      expect(review.records.filter((record) => record.id === "root")).toHaveLength(1);
      expect(review.records.find((record) => record.id === "root")?.phase).toBe("update");
      expect(review.fiberRenders).toEqual([]);

      const empty = await action(page, "empty search", async () => {
        await page.getByRole("textbox", { name: "Search incidents" }).fill("not-an-incident");
        await expect(page.getByText("No incidents match your filters.")).toBeVisible();
        return { search: "not-an-incident", total: "0", rows: 0 };
      });
      const reset = await action(page, "reset empty search", async () => {
        await page.getByRole("textbox", { name: "Search incidents" }).fill("");
        await expect(page.getByRole("row")).toHaveCount(201);
        return { search: "", total: "200", rows: 200 };
      });
      for (const action of [empty, reset]) {
        expect(
          action.records.filter(
            (record) => persistent.includes(record.id) && record.phase === "mount",
          ),
        ).toEqual([]);
        expect(action.records.find((record) => record.id === "list")?.phase).toBe("update");
      }
      const remounts = reset.records.filter((record) => /^(row:|button:)/.test(record.id));
      expect(remounts).toHaveLength(visibleIds.length * 3);
      expect(
        remounts.every((record) => record.phase === "mount" && record.boundaryGeneration === 2),
      ).toBe(true);
      expect(reset.fiberRenders.filter((id) => /^(row:|button:)/.test(id))).toEqual([]);
      expect(reset.records.every((record) => record.rootGeneration === 1)).toBe(true);
      expect(reset.records[0].commitSequence).toBeGreaterThan(empty.records[0].commitSequence);
    } finally {
      await context.close();
    }
  }
});

test("normal-build painted table and favorite CPU at 4x slowdown", async ({ browser }) => {
  test.setTimeout(120000);
  mkdirSync(directory, { recursive: true });
  type LoadSample = {
    uptlMs: number;
    heapBeforeBytes: number;
    heapAfterBytes: number;
  };
  const repetitions: (Record<AppName, LoadSample> & { order: AppName[] })[] = [];
  for (let repeat = 0; repeat < loadMemoryOrders.length; repeat++) {
    const results = {} as Record<AppName, LoadSample>;
    const order = loadMemoryOrders[repeat] as AppName[];
    for (const app of order) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => {
          let pending = false;
          const observer = new MutationObserver(() => {
            if (pending || document.querySelectorAll("tbody tr").length !== 200) return;
            pending = true;
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                (window as typeof window & { __uptl: number }).__uptl = performance.now();
              }),
            );
          });
          observer.observe(document, { subtree: true, childList: true });
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(productionOrigins[app]);
        await page.waitForFunction(() =>
          Number.isFinite((window as typeof window & { __uptl?: number }).__uptl),
        );
        const uptlMs = await page.evaluate(
          () => (window as typeof window & { __uptl: number }).__uptl,
        );
        expect(uptlMs).toBeGreaterThan(0);
        await expect(page.getByRole("row")).toHaveCount(201);
        await cdp.send("Performance.enable");
        async function retainedHeapBytes() {
          await cdp.send("HeapProfiler.collectGarbage");
          const { metrics } = await cdp.send("Performance.getMetrics");
          const bytes = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
          expect(bytes).toBeGreaterThan(0);
          return bytes!;
        }
        const heapBeforeBytes = await retainedHeapBytes();
        if (repeat === 0) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
          await cdp.send("Profiler.start");
        }
        await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        if (repeat === 0) {
          const { profile } = await cdp.send("Profiler.stop");
          expect(profile.samples?.length).toBeGreaterThan(0);
          writeFileSync(`${directory}/favorite-${app}.cpuprofile`, JSON.stringify(profile));
        }
        const heapAfterBytes = await retainedHeapBytes();
        results[app] = { uptlMs, heapBeforeBytes, heapAfterBytes };
        await cdp.detach();
      } finally {
        await context.close();
      }
    }
    repetitions.push({ order, ...results });
  }
  writeFileSync(`${directory}/slowdown.json`, JSON.stringify({ cpuRate: 4, repetitions }, null, 2));
});

test("normal-build selection responsiveness at 4x slowdown", async ({ browser }) => {
  test.setTimeout(180000);
  mkdirSync(directory, { recursive: true });
  const contexts: Awaited<ReturnType<Browser["newContext"]>>[] = [];
  const pages = {} as Record<AppName, Page>;
  const repetitions: Record<AppName, { domMs: number; paintMs: number }>[] = [];
  try {
    for (const app of apps) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      contexts.push(context);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(productionOrigins[app]);
      await expect(page.getByRole("row")).toHaveCount(201);
      await page
        .getByRole("navigation", { name: "Incident queues" })
        .getByRole("button", { name: "Platform" })
        .click();
      await expect(page.getByTestId("total")).toHaveText("67");
      await page.getByRole("button", { name: "Open INC-0001" }).click();
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("INC-0001");
      await page.getByRole("button", { name: "Close detail" }).click();
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText(
        "No incident selected",
      );
      pages[app] = page;
    }
    for (let iteration = 0; iteration < 20; iteration++) {
      const samples = {} as Record<AppName, { domMs: number; paintMs: number }>;
      for (const app of [
        ...apps.slice(iteration % apps.length),
        ...apps.slice(0, iteration % apps.length),
      ]) {
        const page = pages[app];
        await page.evaluate(() => {
          const browserWindow = window as typeof window & {
            __selectionTiming?: {
              start: number;
              domMs?: number;
              paintMs?: number;
            };
          };
          const button = document.querySelector<HTMLButtonElement>('[aria-label="Open INC-0001"]')!;
          button.addEventListener(
            "click",
            () => {
              const timing = { start: performance.now() } as {
                start: number;
                domMs?: number;
                paintMs?: number;
              };
              browserWindow.__selectionTiming = timing;
              const observer = new MutationObserver(() => {
                if (
                  !document
                    .querySelector('[aria-label="Incident detail"]')
                    ?.textContent?.includes("INC-0001")
                )
                  return;
                observer.disconnect();
                timing.domMs = performance.now() - timing.start;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    timing.paintMs = performance.now() - timing.start;
                  }),
                );
              });
              observer.observe(document.getElementById("root")!, {
                subtree: true,
                childList: true,
                characterData: true,
              });
            },
            { once: true },
          );
        });
        await page.getByRole("button", { name: "Open INC-0001" }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __selectionTiming?: { paintMs?: number };
                  }
                ).__selectionTiming?.paintMs,
            ),
          )
          .toBeGreaterThan(0);
        const sample = await page.evaluate(
          () =>
            (
              window as typeof window & {
                __selectionTiming: { domMs: number; paintMs: number };
              }
            ).__selectionTiming,
        );
        expect(sample.domMs).toBeGreaterThan(0);
        samples[app] = { domMs: sample.domMs, paintMs: sample.paintMs };
        await page.getByRole("button", { name: "Close detail" }).click();
        await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText(
          "No incident selected",
        );
      }
      repetitions.push(samples);
    }
    writeFileSync(
      `${directory}/selection-latency.json`,
      JSON.stringify({ cpuRate: 4, repetitions }, null, 2),
    );
  } finally {
    for (const context of contexts) await context.close();
  }
});

type FilteringSample = {
  name: string;
  query: string;
  rows: number;
  resultsChanged: boolean;
  resultIds: string[];
  domMs: number | null;
  paintMs: number;
};

async function filteringCycle(page: Page): Promise<FilteringSample[]> {
  const samples: FilteringSample[] = [];
  const input = page.getByRole("textbox", { name: "Search incidents" });
  await expect(input).toHaveValue("");
  expect(await page.locator("tbody .incident-id").allTextContents()).toEqual(
    filteringProtocol.initialIds,
  );
  for (const step of filteringProtocol.steps) {
    await page.evaluate(
      ({ step, expectedIds }) => {
        const browserWindow = window as typeof window & {
          __filteringTiming?: FilteringSample & { start: number };
        };
        const textbox = document.querySelector<HTMLInputElement>(
          '[aria-label="Search incidents"]',
        )!;
        const ids = () =>
          [...document.querySelectorAll("tbody .incident-id")].map(
            (element) => element.textContent!,
          );
        const matches = () =>
          textbox.value === step.query &&
          JSON.stringify(ids()) === JSON.stringify(expectedIds) &&
          document.querySelector('[data-testid="total"]')!.textContent === String(step.rows);
        textbox.addEventListener(
          "input",
          () => {
            const timing = {
              ...step,
              start: performance.now(),
              domMs: null,
              paintMs: 0,
              resultIds: [],
            } as FilteringSample & { start: number };
            browserWindow.__filteringTiming = timing;
            let observer: MutationObserver | undefined;
            const finish = () => {
              if (!matches()) return;
              observer?.disconnect();
              if (step.resultsChanged) timing.domMs = performance.now() - timing.start;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  if (!matches()) return;
                  timing.resultIds = ids();
                  timing.paintMs = performance.now() - timing.start;
                }),
              );
            };
            if (step.resultsChanged) {
              observer = new MutationObserver(finish);
              observer.observe(document.getElementById("root")!, {
                subtree: true,
                childList: true,
                characterData: true,
              });
            } else finish();
          },
          { once: true, capture: true },
        );
      },
      { step, expectedIds: filteringResultIds(step.query) },
    );
    if (step.query)
      await input.pressSequentially(step.query.at(-1)!, {
        delay: filteringProtocol.minimumKeyDelayMs,
      });
    else await input.fill("");
    await page.waitForFunction(
      () =>
        (window as typeof window & { __filteringTiming?: FilteringSample }).__filteringTiming!
          .paintMs > 0,
    );
    const sample = await page.evaluate(() => {
      const { start: _start, ...timing } = (
        window as typeof window & {
          __filteringTiming: FilteringSample & { start: number };
        }
      ).__filteringTiming;
      return timing;
    });
    expect(sample.resultIds).toEqual(filteringResultIds(step.query));
    expect(sample.domMs === null).toBe(!step.resultsChanged);
    await expect(input).toHaveValue(step.query);
    samples.push(sample);
  }
  return samples;
}

test("normal-build typed filtering and clearing at 4x slowdown", async ({ browser }) => {
  test.setTimeout(180000);
  mkdirSync(directory, { recursive: true });
  const contexts: Awaited<ReturnType<Browser["newContext"]>>[] = [];
  const pages = {} as Record<AppName, Page>;
  const repetitions = [];
  try {
    for (const app of apps) {
      const context = await browser.newContext({ viewport: filteringProtocol.viewport });
      contexts.push(context);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(productionOrigins[app]);
      await expect(page.getByRole("row")).toHaveCount(201);
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText(
        "No incident selected",
      );
      await filteringCycle(page);
      pages[app] = page;
    }
    for (let iteration = 0; iteration < 20; iteration++) {
      const order = [...apps.slice(iteration % 3), ...apps.slice(0, iteration % 3)];
      const samples = {} as Record<AppName, FilteringSample[]>;
      for (const app of order) samples[app] = await filteringCycle(pages[app]);
      repetitions.push({ order, ...samples });
    }
    writeFileSync(
      `${directory}/filtering-latency.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          browser: browser.version(),
          cpuRate: 4,
          protocol: filteringProtocol,
          repetitions,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const context of contexts) await context.close();
  }
});

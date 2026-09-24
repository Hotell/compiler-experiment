import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { RenderRecord } from "./recorder";

const directory = "benchmark/results";
const origins = { compiler: "http://127.0.0.1:4173", manual: "http://127.0.0.1:4174" } as const;
const productionOrigins = {
  compiler: "http://127.0.0.1:4273",
  manual: "http://127.0.0.1:4274",
} as const;
type AppName = keyof typeof origins;
type Action = { name: string; records: RenderRecord[]; state: string };

async function snapshot(page: Page) {
  return JSON.stringify({
    main: await page.locator("main").innerText(),
    detail: await page.getByRole("dialog", { name: "Incident detail" }).innerText(),
    reviews: await page.getByTestId("reviews").innerText(),
    favorite: await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).count(),
  });
}

async function action(page: Page, name: string, change: () => Promise<void>): Promise<Action> {
  await page.evaluate(() => window.__benchmark!.clear());
  await change();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__benchmark!.records.filter((record) => record.phase !== "mount").length,
      ),
    )
    .toBeGreaterThan(0);
  const records = await page.evaluate(() => window.__benchmark!.records);
  return { name, records, state: await snapshot(page) };
}

async function scenario(page: Page, trace: boolean) {
  await expect(page.getByRole("heading", { name: "Incident triage" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(201);
  await expect
    .poll(() => page.evaluate(() => window.__benchmark?.records.length ?? 0))
    .toBeGreaterThan(0);
  const mounts = await page.evaluate(() =>
    window.__benchmark!.records.filter((record) => record.phase === "mount"),
  );
  const actions: Action[] = [];
  actions.push(
    await action(page, "header review", async () => {
      await page.getByRole("button", { name: "Add review" }).click();
      await expect(page.getByTestId("reviews")).toHaveText("1");
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
    }),
  );
  actions.push(
    await action(page, "select incident", async () => {
      await page.getByRole("button", { name: "Open INC-0001" }).click();
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("INC-0001");
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
  actions.push(
    await action(page, "search", async () => {
      await page.getByRole("textbox", { name: "Search incidents" }).fill("INC-0001");
      await expect(page.getByTestId("total")).toHaveText("1");
    }),
  );
  actions.push(
    await action(page, "filter status", async () => {
      await page.getByRole("combobox", { name: "Status" }).selectOption("Open");
      await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("Open");
    }),
  );
  actions.push(
    await action(page, "sort and reset", async () => {
      await page.getByRole("combobox", { name: "Sort" }).selectOption("severity");
      await page.getByRole("textbox", { name: "Search incidents" }).fill("");
      await page.getByRole("combobox", { name: "Status" }).selectOption("All statuses");
      await page
        .getByRole("navigation", { name: "Incident queues" })
        .getByRole("button", { name: "All incidents" })
        .click();
      await expect(page.getByTestId("total")).toHaveText("200");
    }),
  );
  actions.push(
    await action(page, "resolve incident", async () => {
      await page.getByRole("button", { name: "Mark resolved" }).click();
      await expect(page.getByTestId("open-count")).toHaveText("66");
      await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText("Resolved");
    }),
  );
  return { mounts: mounts.length, actions };
}

async function run(browser: Browser, app: AppName, trace = false, screenshot = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origins[app]);
    if (screenshot) {
      await expect(page.getByRole("heading", { name: "Incident triage" })).toBeVisible();
      await page.screenshot({ path: `${directory}/${app}-desktop.png` });
    }
    return await scenario(page, trace);
  } finally {
    await context.close();
  }
}

test("matched incident workflows and profiling recorder", async ({ browser }) => {
  test.setTimeout(180000);
  mkdirSync(directory, { recursive: true });
  await run(browser, "compiler", false, true);
  await run(browser, "manual", false, true);
  const repetitions = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = {} as Record<AppName, Awaited<ReturnType<typeof run>>>;
    const order: AppName[] = repeat % 2 ? ["manual", "compiler"] : ["compiler", "manual"];
    for (const app of order)
      results[app] = await run(browser, app, Boolean(process.env.BENCHMARK_TRACE) && repeat === 0);
    expect(results.compiler.actions.map((entry) => entry.state)).toEqual(
      results.manual.actions.map((entry) => entry.state),
    );
    repetitions.push(results);
  }
  let mobileState: string | undefined;
  for (const app of ["compiler", "manual"] as const) {
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
    JSON.stringify({ repetitions, browser: browser.version() }, null, 2),
  );
});

test("normal-build painted table and favorite CPU at 4x slowdown", async ({ browser }) => {
  test.setTimeout(120000);
  mkdirSync(directory, { recursive: true });
  const repetitions: Record<AppName, { uptlMs: number }>[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = {} as Record<AppName, { uptlMs: number }>;
    const order: AppName[] = repeat % 2 ? ["manual", "compiler"] : ["compiler", "manual"];
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
        results[app] = { uptlMs };
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
        await cdp.detach();
      } finally {
        await context.close();
      }
    }
    repetitions.push(results);
  }
  writeFileSync(`${directory}/slowdown.json`, JSON.stringify({ cpuRate: 4, repetitions }, null, 2));
});

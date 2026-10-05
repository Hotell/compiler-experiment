import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFiberRecorder } from "./fiber-recorder";
import {
  beginActionWindow,
  collectActionSnapshot,
  type ActionSample,
  type Outcome,
} from "./collection";
import { balancedPairOrders, type Arm, type PairOrder } from "./row-ablation-order";

const experiment = "manual-row-memo";
const reactVersion = "19.3.0";
const viewport = { width: 1440, height: 900 };
const cpuRate = 4;
const seed = 20260929;
const arms: Arm[] = ["on", "off"];
const origins = {
  on: { profile: "http://127.0.0.1:4371", production: "http://127.0.0.1:4471" },
  off: { profile: "http://127.0.0.1:4372", production: "http://127.0.0.1:4472" },
};
const actionNames = ["switch queue", "select incident", "favorite incident"] as const;
type ActionName = (typeof actionNames)[number];
type BuildMode = "production" | "profile";
type BuildMetadata = {
  schemaVersion: 1;
  experiment: typeof experiment;
  arm: Arm;
  mode: BuildMode;
  reactVersion: typeof reactVersion;
  sourceFingerprint: string;
};
type ProfileAction = ActionSample & { name: ActionName };
type ProductionAction = { name: ActionName; domMs: number; frameMs: number; state: string };
type ProfileScenario = { actions: ProfileAction[] };
type ProductionScenario = { actions: ProductionAction[] };
type ProfileRun = {
  repeat: number;
  order: PairOrder;
  arms: Record<Arm, ProfileScenario>;
};
type Pair = {
  block: number;
  pair: number;
  order: PairOrder;
  arms: Record<Arm, ProductionScenario>;
};
type InteractionTiming =
  | { status: "pending"; phase: "armed" | "dispatched" | "frame" }
  | { status: "complete"; domMs: number; frameMs: number }
  | { status: "failed"; message: string };

declare global {
  interface Window {
    __rowMemoTiming?: InteractionTiming;
    __rowMemoTimingCleanup?: () => void;
  }
}

async function buildMetadata(request: APIRequestContext, arm: Arm, mode: BuildMode) {
  const url = `${origins[arm][mode]}/ablation.json`;
  const response = await request.get(url);
  expect(response.ok(), `Missing ablation metadata: ${url} (${response.status()})`).toBe(true);
  const value: unknown = await response.json();
  function validate(value: unknown): asserts value is BuildMetadata {
    if (
      !value ||
      typeof value !== "object" ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("experiment" in value) ||
      value.experiment !== experiment ||
      !("arm" in value) ||
      value.arm !== arm ||
      !("mode" in value) ||
      value.mode !== mode ||
      !("reactVersion" in value) ||
      value.reactVersion !== reactVersion ||
      !("sourceFingerprint" in value) ||
      typeof value.sourceFingerprint !== "string" ||
      !value.sourceFingerprint.trim()
    )
      throw new Error(`Invalid ablation metadata at ${url}: ${JSON.stringify(value)}`);
  }
  validate(value);
  return value;
}

function actionButton(page: Page, name: ActionName) {
  switch (name) {
    case "switch queue":
      return page
        .getByRole("navigation", { name: "Incident queues" })
        .getByRole("button", { name: "Platform" });
    case "select incident":
      return page.getByRole("button", { name: "Open INC-0001", exact: true });
    case "favorite incident":
      return page.getByRole("button", { name: "Favorite INC-0001", exact: true });
  }
}

function outcome(name: ActionName): Outcome {
  switch (name) {
    case "switch queue":
      return { total: "67", rows: 67, queue: "Platform", favorite: false };
    case "select incident":
      return { total: "67", rows: 67, detailIncludes: "INC-0001", favorite: false };
    case "favorite incident":
      return { total: "67", rows: 67, favorite: true, detailIncludes: "Favorite changed" };
  }
}

async function expectInitialState(page: Page) {
  await expect(page.getByRole("heading", { name: "Incident triage" })).toBeVisible();
  await expect(page.getByTestId("total")).toHaveText("200");
  await expect(page.locator("tbody tr")).toHaveCount(200);
  await expect(
    page
      .getByRole("navigation", { name: "Incident queues" })
      .getByRole("button", { name: "All incidents" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Search incidents" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("All statuses");
  await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue("newest");
  await expect(page.getByRole("dialog", { name: "Incident detail" })).toContainText(
    "No incident selected",
  );
  await expect(page.locator("tbody tr.selected")).toHaveCount(0);
  await expect(page.locator("tbody button[aria-pressed=true]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Favorite INC-0001", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("notifications")).toHaveText("3");
}

async function expectActionState(page: Page, name: ActionName, activityBefore: number) {
  await expect(page.getByTestId("total")).toHaveText("67");
  await expect(page.locator("tbody tr")).toHaveCount(67);
  const detail = page.getByRole("dialog", { name: "Incident detail" });
  if (name === "switch queue") {
    await expect(detail).toContainText("No incident selected");
    await expect(page.locator("tbody tr.selected")).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Incident queues" })
        .getByRole("button", { name: "Platform" }),
    ).toHaveAttribute("aria-current", "page");
  } else {
    await expect(detail.locator(".detail-id")).toHaveText("INC-0001");
    await expect(page.locator("tbody tr.selected .incident-id")).toHaveText("INC-0001");
    await expect(detail.locator(".activity-list li")).toHaveCount(
      activityBefore + (name === "favorite incident" ? 1 : 0),
    );
  }
  const favorite = name === "favorite incident";
  await expect(
    page.getByRole("button", {
      name: `${favorite ? "Unfavorite" : "Favorite"} INC-0001`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", String(favorite));
}

async function profileSnapshot(page: Page, expected: Outcome) {
  let sample: ActionSample | undefined;
  await expect
    .poll(async () => {
      const result = await page.evaluate(collectActionSnapshot, { outcome: expected });
      if (result.status === "complete") sample = result.sample;
      return result.status === "complete" ? "complete" : result.reason;
    })
    .toBe("complete");
  if (!sample) throw new Error(`Incomplete profile action: ${JSON.stringify(expected)}`);
  return sample;
}

function verifyProfileWork(action: ProfileAction, arm: Arm) {
  const expectedRows = arm === "off" ? 67 : action.name === "switch queue" ? 0 : 1;
  const rows = action.fiberRenders.filter((id) => id.startsWith("row:"));
  expect(rows, `${arm}: ${action.name} row work`).toHaveLength(expectedRows);
  if (arm === "on" && expectedRows === 1) expect(rows).toEqual(["row:INC-0001"]);
  expect(
    action.fiberRenders.filter((id) => id.startsWith("button:open:")),
    `${arm}: ${action.name} open-button work`,
  ).toEqual([]);
  expect(
    action.fiberRenders.filter((id) => id.startsWith("button:favorite:")),
    `${arm}: ${action.name} favorite-button work`,
  ).toEqual(action.name === "favorite incident" ? ["button:favorite:INC-0001"] : []);
  for (const id of ["root", "list"]) {
    const records = action.records.filter((record) => record.id === id);
    expect(records.length, `${arm}: ${action.name} missing native ${id} records`).toBeGreaterThan(
      0,
    );
    for (const record of records) {
      expect(record.phase).not.toBe("mount");
      expect(Number.isFinite(record.actualDuration)).toBe(true);
      expect(Number.isFinite(record.baseDuration)).toBe(true);
      expect(record.actualDuration).toBeGreaterThanOrEqual(0);
      expect(record.baseDuration).toBeGreaterThanOrEqual(0);
    }
  }
}

async function runProfileScenario(browser: Browser, arm: Arm): Promise<ProfileScenario> {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    await page.addInitScript({
      content: `window.__fiberBenchmark = (${createFiberRecorder.toString()})(() => window.__benchmark);
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__fiberBenchmark.hook;`,
    });
    // Native, unthrottled profiling is separate from the 4x production latency experiment.
    await page.goto(origins[arm].profile);
    await expectInitialState(page);
    expect(await page.evaluate(() => window.__benchmark?.schemaVersion)).toBe(2);
    await profileSnapshot(page, { total: "200", rows: 200, notifications: "3", favorite: false });
    const actions: ProfileAction[] = [];
    for (const name of actionNames) {
      await page.evaluate(beginActionWindow);
      await actionButton(page, name).click();
      await expectActionState(page, name, 2);
      const action = { name, ...(await profileSnapshot(page, outcome(name))) };
      verifyProfileWork(action, arm);
      actions.push(action);
    }
    return { actions };
  } finally {
    await context.close();
  }
}

async function assertNormalBuild(page: Page) {
  expect(
    await page.evaluate(() => ({
      timing: "__benchmark" in window,
      fibers: "__fiberBenchmark" in window,
      devtools: "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window,
    })),
    "Production latency must have no profiling recorder or diagnostic hook",
  ).toEqual({ timing: false, fibers: false, devtools: false });
}

function productionState() {
  function element<T extends HTMLElement>(selector: string): T {
    const value = document.querySelector<T>(selector);
    if (!value) throw new Error(`Row ablation state is missing ${selector}`);
    return value;
  }
  return JSON.stringify({
    main: element("main").innerText,
    detail: element('[aria-label="Incident detail"]').innerText,
    notifications: element('[data-testid="notifications"]').innerText,
    favorite: document.querySelectorAll('tbody [aria-pressed="true"]').length,
    queue: element('[aria-label="Incident queues"] [aria-current="page"]').textContent,
    search: element<HTMLInputElement>('[aria-label="Search incidents"]').value,
    status: element<HTMLSelectElement>('[aria-label="Status"]').value,
    sort: element<HTMLSelectElement>('[aria-label="Sort"]').value,
    selected: Array.from(document.querySelectorAll("tbody tr.selected .incident-id"), (node) =>
      node.textContent?.trim(),
    ),
  });
}

async function measureInteraction(page: Page, name: ActionName) {
  const button = actionButton(page, name);
  try {
    await button.evaluate((element, name) => {
      if (window.__rowMemoTimingCleanup)
        throw new Error("Previous row ablation interaction was not cleaned up");
      const root = document.getElementById("root");
      if (!root) throw new Error("Row ablation timing requires #root");
      function completeTarget() {
        if (name === "switch queue")
          return (
            document.querySelector('[data-testid="total"]')?.textContent?.trim() === "67" &&
            document.querySelectorAll("tbody tr").length === 67 &&
            document
              .querySelector('[aria-label="Incident queues"] [aria-current="page"]')
              ?.textContent?.trim()
              .startsWith("Platform")
          );
        if (name === "select incident")
          return (
            document
              .querySelector('[aria-label="Incident detail"] .detail-id')
              ?.textContent?.trim() === "INC-0001" &&
            document.querySelector("tbody tr.selected .incident-id")?.textContent?.trim() ===
              "INC-0001"
          );
        return (
          document
            .querySelector('[aria-label="Unfavorite INC-0001"]')
            ?.getAttribute("aria-pressed") === "true" &&
          document
            .querySelector('[aria-label="Incident detail"] .detail-id')
            ?.textContent?.trim() === "INC-0001" &&
          document.querySelector('[aria-label="Unfavorite detail"]') !== null
        );
      }
      if (completeTarget()) throw new Error(`Row ablation target was already met: ${name}`);
      window.__rowMemoTiming = { status: "pending", phase: "armed" };
      let start = 0;
      let frame = 0;
      let timer = 0;
      const observer = new MutationObserver(() => {
        if (!completeTarget()) return;
        const domMs = performance.now() - start;
        observer.disconnect();
        window.__rowMemoTiming = { status: "pending", phase: "frame" };
        // A double-rAF frame opportunity, not actual paint, INP, or pre-dispatch input delay.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            const frameMs = performance.now() - start;
            cleanup();
            window.__rowMemoTiming = { status: "complete", domMs, frameMs };
          });
        });
      });
      function cleanup() {
        element.removeEventListener("click", begin, true);
        observer.disconnect();
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        delete window.__rowMemoTimingCleanup;
      }
      function begin() {
        // Native target capture runs before React's delegated bubble click handler.
        start = performance.now();
        window.__rowMemoTiming = { status: "pending", phase: "dispatched" };
        observer.observe(root!, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      }
      window.__rowMemoTimingCleanup = cleanup;
      element.addEventListener("click", begin, { capture: true, once: true });
      timer = window.setTimeout(() => {
        const phase = window.__rowMemoTiming;
        const diagnostics = {
          phase,
          total: document.querySelector('[data-testid="total"]')?.textContent,
          rows: document.querySelectorAll("tbody tr").length,
          detail: document.querySelector('[aria-label="Incident detail"]')?.textContent,
          favorite: document
            .querySelector('[aria-label="Unfavorite INC-0001"]')
            ?.getAttribute("aria-pressed"),
        };
        cleanup();
        window.__rowMemoTiming = {
          status: "failed",
          message: `${name} did not complete within 10000ms: ${JSON.stringify(diagnostics)}`,
        };
      }, 10000);
    }, name);
    await button.click();
    await page.waitForFunction(() => window.__rowMemoTiming?.status !== "pending", undefined, {
      timeout: 15000,
    });
    const result = await page.evaluate(() => window.__rowMemoTiming);
    if (!result || result.status === "pending")
      throw new Error(`Missing completed timing for ${name}`);
    if (result.status === "failed") throw new Error(result.message);
    expect(Number.isFinite(result.domMs)).toBe(true);
    expect(Number.isFinite(result.frameMs)).toBe(true);
    expect(result.domMs).toBeGreaterThanOrEqual(0);
    expect(result.frameMs).toBeGreaterThanOrEqual(result.domMs);
    return { domMs: result.domMs, frameMs: result.frameMs };
  } finally {
    await page.evaluate(() => {
      window.__rowMemoTimingCleanup?.();
      delete window.__rowMemoTiming;
    });
  }
}

async function runProductionScenario(
  page: Page,
  activityBefore: number,
): Promise<ProductionScenario> {
  await page.bringToFront();
  const actions: ProductionAction[] = [];
  for (const name of actionNames) {
    const timing = await measureInteraction(page, name);
    await expectActionState(page, name, activityBefore);
    actions.push({ name, ...timing, state: await page.evaluate(productionState) });
  }
  return { actions };
}

async function resetProductionState(page: Page, expectedActivity: number) {
  await page.bringToFront();
  await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Favorite INC-0001", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  // Undoing the favorite appends history; both arms must accumulate exactly the same entries.
  await expect(
    page.getByRole("dialog", { name: "Incident detail" }).locator(".activity-list li"),
  ).toHaveCount(expectedActivity);
  await page.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("navigation", { name: "Incident queues" })
    .getByRole("button", { name: "All incidents" })
    .click();
  await page.getByRole("textbox", { name: "Search incidents" }).fill("");
  await page.getByRole("combobox", { name: "Status" }).selectOption("All statuses");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("newest");
  await expectInitialState(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function runBlock(browser: Browser, block: number, orders: PairOrder[]): Promise<Pair[]> {
  const contexts = [];
  const pages: Partial<Record<Arm, Page>> = {};
  const initial: Partial<Record<Arm, string>> = {};
  const warmups: Partial<Record<Arm, ProductionScenario>> = {};
  try {
    for (const arm of arms) {
      const context = await browser.newContext({ viewport });
      contexts.push(context);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
      await page.goto(origins[arm].production);
      await assertNormalBuild(page);
      await expectInitialState(page);
      pages[arm] = page;
      initial[arm] = await page.evaluate(productionState);
      warmups[arm] = await runProductionScenario(page, 2);
    }
    expect(initial.on).toEqual(initial.off);
    expect(warmups.on!.actions.map(({ state }) => state)).toEqual(
      warmups.off!.actions.map(({ state }) => state),
    );
    const pairs: Pair[] = [];
    for (const [pair, order] of orders.entries()) {
      const activityBefore = 4 + pair * 2;
      for (const arm of arms) {
        await resetProductionState(pages[arm]!, activityBefore);
        expect(
          await pages[arm]!.evaluate(productionState),
          `${arm} reset in ${block}/${pair}`,
        ).toBe(initial[arm]);
      }
      const results: Partial<Record<Arm, ProductionScenario>> = {};
      for (const arm of order)
        results[arm] = await runProductionScenario(pages[arm]!, activityBefore);
      if (!results.on || !results.off) throw new Error(`Incomplete pair ${block}/${pair}`);
      expect(
        results.on.actions.map(({ state }) => state),
        `State parity in ${block}/${pair}`,
      ).toEqual(results.off.actions.map(({ state }) => state));
      pairs.push({ block, pair, order, arms: { on: results.on, off: results.off } });
    }
    for (const arm of arms) await assertNormalBuild(pages[arm]!);
    return pairs;
  } finally {
    for (const context of contexts) await context.close();
  }
}

test("manual row memo ablation: native profile checks and paired 4x production interactions", async ({
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const builds = {
    on: {
      production: await buildMetadata(request, "on", "production"),
      profile: await buildMetadata(request, "on", "profile"),
    },
    off: {
      production: await buildMetadata(request, "off", "production"),
      profile: await buildMetadata(request, "off", "profile"),
    },
  };
  const sourceFingerprint = builds.on.production.sourceFingerprint;
  for (const arm of arms)
    for (const mode of ["production", "profile"] as const)
      expect(builds[arm][mode].sourceFingerprint, `${arm}/${mode} source mismatch`).toBe(
        sourceFingerprint,
      );

  const profileRuns: ProfileRun[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const order: PairOrder = repeat % 2 === 0 ? ["on", "off"] : ["off", "on"];
    const results: Partial<Record<Arm, ProfileScenario>> = {};
    for (const arm of order) results[arm] = await runProfileScenario(browser, arm);
    if (!results.on || !results.off) throw new Error(`Incomplete profile repeat ${repeat}`);
    expect(results.on.actions.map(({ state }) => state)).toEqual(
      results.off.actions.map(({ state }) => state),
    );
    profileRuns.push({ repeat, order, arms: { on: results.on, off: results.off } });
  }
  const pairs: Pair[] = [];
  for (const [block, orders] of balancedPairOrders(seed).entries())
    pairs.push(...(await runBlock(browser, block, orders)));
  expect(profileRuns).toHaveLength(3);
  expect(pairs).toHaveLength(30);

  const result = {
    schemaVersion: 1,
    experiment,
    browser: browser.version(),
    reactVersion,
    sourceFingerprint,
    cpuRate,
    viewport,
    seed,
    blocks: 3,
    pairsPerBlock: 10,
    warmupsPerArm: 1,
    builds,
    profileRuns,
    pairs,
  };
  const directory = "benchmark/results/row-memo";
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/measurements.json`, JSON.stringify(result, null, 2));
});

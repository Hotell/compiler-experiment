import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { checkDevtools } from "./check-devtools.mjs";
import { analyzeLoadMemory } from "./load-memory.mjs";
import { analyzeFiltering, analyzeUplt } from "./report-evidence.mjs";
import { reportSections } from "./report-markdown.mjs";

const root = resolve("dist-pages");
const prefix = "/compiler-experiment/";
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(404).end();
    return;
  }
  const path = join(
    root,
    decodeURIComponent(url.pathname.slice(prefix.length)),
    url.pathname.endsWith("/") ? "index.html" : "",
  );
  if (relative(root, path).startsWith("..")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const content = readFileSync(path);
    response
      .writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
      })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});

const preview = process.argv.includes("--serve");
await new Promise((done) => server.listen(preview ? 4180 : 0, "127.0.0.1", done));
if (preview) {
  console.log(`Pages preview: http://127.0.0.1:${server.address().port}${prefix}`);
} else {
  for (const app of ["compiler", "manual", "baseline"]) {
    for (const mode of ["dist", "dist-profile-pages"]) {
      const directory = `apps/${app}/${mode}`;
      for (const file of readdirSync(directory, { recursive: true })) {
        if (!/\.(js|html)$/.test(file)) continue;
        assert.doesNotMatch(
          readFileSync(join(directory, file), "utf8"),
          /react-scan|__REACT_SCAN/,
          `${directory}/${file}: Scan must only be injected during Pages assembly`,
        );
      }
    }
  }
  const undersizedText = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter(
          (element) =>
            element.getClientRects().length &&
            [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
            ),
        )
        .map((element) => ({
          text: element.textContent.trim().slice(0, 40),
          size: parseFloat(getComputedStyle(element).fontSize),
        }))
        .filter(({ size }) => size < 16),
    );
  const browser = await chromium.launch();
  try {
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    mkdirSync("benchmark/results", { recursive: true });
    for (const [name, width, height] of [
      ["desktop", 1440, 900],
      ["mobile", 390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const externalRequests = [];
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(base).origin && /^https?:$/.test(url.protocol)) {
          externalRequests.push(url.href);
          return route.abort();
        }
        return route.continue();
      });
      const failedResources = [];
      page.on("requestfailed", (request) => failedResources.push(request.url()));
      page.on("response", (response) => {
        if (response.status() >= 400)
          failedResources.push(`${response.status()} ${response.url()}`);
      });
      for (const app of ["compiler", "manual", "baseline"]) {
        const home = await page.goto(base);
        assert.equal(home.status(), 200);
        assert.equal(
          await page
            .getByRole("heading", {
              name: "React Compiler vs. manual memoization",
            })
            .count(),
          1,
        );
        assert.equal(
          await page
            .locator("img")
            .evaluateAll(
              (images) => images.filter((image) => image.complete && image.naturalWidth > 0).length,
            ),
          1,
          "shared chooser image must load",
        );
        assert.equal(await page.locator(".route").count(), 3);
        assert.deepEqual(
          await page
            .locator(".route-main")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
          ["./baseline/", "./manual/", "./compiler/"],
        );
        assert.deepEqual(await page.locator(".route h2").allTextContents(), [
          "No memoization",
          "Manual memoization",
          "React Compiler",
        ]);
        assert.deepEqual(await page.locator(".route-index").allTextContents(), [
          "01 / BASELINE",
          "02 / MANUAL",
          "03 / COMPILER",
        ]);
        assert.deepEqual(
          await page
            .getByRole("link", { name: "Compare output" })
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
          ["./sources/", "./sources/compiler-manual-App.html", "./sources/"],
        );
        assert.deepEqual(
          await page
            .getByRole("link", { name: "Open with Profiler" })
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
          ["./profile/baseline/", "./profile/manual/", "./profile/compiler/"],
        );
        assert.equal(await page.getByText(/Compiler (on|off)/).count(), 0);
        assert.ok(
          (await page.locator(".route").first().boundingBox()).height <=
            (name === "mobile" ? 300 : 320),
          `${name} implementation cards should be compact`,
        );
        if (app === "compiler") {
          assert.deepEqual(await undersizedText(page), [], `${name} chooser text is below 16px`);
          await page.screenshot({ path: `benchmark/results/pages-${name}.png` });
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${name} chooser overflows horizontally`,
          );
        }
        await page.locator(`.route-main[href="./${app}/"]`).click();
        assert.equal(new URL(page.url()).pathname, `${prefix}${app}/`);
        await page.getByRole("heading", { name: "Incident triage" }).waitFor();
        assert.equal(await page.getByRole("row").count(), 201, `${app} incidents must render`);
        const normalScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.equal(
          await page.evaluate(() => window.__benchmark),
          undefined,
          `${app} normal build must omit the recorder`,
        );
        assert.equal(await page.locator(".profile-banner").count(), 0);
        assert.equal(await page.locator("#react-scan-root").count(), 0);
        assert.equal(await page.evaluate(() => window.__REACT_SCAN__), undefined);
        assert.equal(await page.evaluate(() => window.__REACT_DEVTOOLS_GLOBAL_HOOK__), undefined);
        await page.goto(base);
        await page.locator(`.route-extra a[href="./profile/${app}/"]`).click();
        assert.equal(new URL(page.url()).pathname, `${prefix}profile/${app}/`);
        await page.getByRole("heading", { name: "Incident triage" }).waitFor();
        assert.equal(
          await page.getByRole("row").count(),
          201,
          `${app} profiling incidents must render`,
        );
        assert.match(await page.title(), /Profiling enabled/);
        assert.deepEqual(
          await page
            .locator("head script")
            .first()
            .evaluate((script) => ({
              src: script.getAttribute("src"),
              type: script.type,
              async: script.async,
              defer: script.defer,
            })),
          { src: "../scan/react-scan.js", type: "", async: false, defer: false },
          "Scan must load synchronously before the React entry module",
        );
        assert.equal(await page.getByText("Profiling enabled", { exact: true }).count(), 1);
        assert.equal(
          await page.locator("#root .profile-banner").count(),
          0,
          "Profile banner must stay outside the React tree",
        );
        const toolbar = page.locator("#react-scan-root #react-scan-toolbar-root");
        await toolbar.getByTitle("Inspect element", { exact: true }).waitFor();
        assert.equal(await page.locator("#root #react-scan-root").count(), 0);
        assert.equal(
          await toolbar.getByTitle("Inspect element", { exact: true }).isVisible(),
          true,
        );
        const scanState = await page.evaluate(() => {
          const scan = window.__REACT_SCAN__.ReactScanInternals;
          return {
            production: scan.options.value.dangerouslyForceRunInProduction,
            paused: scan.instrumentation.isPaused.value,
            renderers: window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size,
          };
        });
        assert.deepEqual(scanState, {
          production: true,
          paused: false,
          renderers: 1,
        });
        await toolbar.getByTitle("Outline Re-renders", { exact: true }).click();
        await page.waitForFunction(
          () => window.__REACT_SCAN__.ReactScanInternals.instrumentation.isPaused.value,
        );
        await toolbar.getByTitle("Outline Re-renders", { exact: true }).click();
        await page.waitForFunction(
          () => !window.__REACT_SCAN__.ReactScanInternals.instrumentation.isPaused.value,
        );
        await page.evaluate(() => {
          window.__scanRenderCount = 0;
          window.__REACT_SCAN__.ReactScanInternals.options.value.onRender = () => {
            window.__scanRenderCount++;
          };
        });
        assert.equal(
          await page.evaluate(() => window.__fiberBenchmark),
          undefined,
          "The benchmark's private fiber probe must not ship",
        );
        await page.getByText("How to profile", { exact: true }).click();
        assert.deepEqual(
          await page
            .locator(".profile-banner")
            .evaluate((banner) =>
              [...banner.querySelectorAll("*")]
                .filter(
                  (element) =>
                    element.getClientRects().length &&
                    parseFloat(getComputedStyle(element).fontSize) < 16,
                )
                .map((element) => element.textContent),
            ),
          [],
          `${name} profiling instructions must remain readable`,
        );
        const mounts = await page.evaluate(() => {
          window.__benchmark.assertComplete();
          const records = window.__benchmark.records;
          window.__benchmark.clear();
          return records;
        });
        assert.ok(mounts.some((record) => record.id === "root" && record.phase === "mount"));
        await page.getByRole("button", { name: "Open INC-0001", exact: true }).click();
        await page.getByRole("dialog", { name: "Incident detail" }).waitFor();
        await page.getByRole("button", { name: "Close detail" }).click();
        await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
        await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).waitFor();
        const updates = await page.evaluate(() => {
          window.__benchmark.assertComplete();
          return window.__benchmark.records;
        });
        assert.ok(updates.filter((record) => record.id === "root").length >= 3);
        assert.ok(
          (await page.evaluate(() => window.__scanRenderCount)) > 0,
          `${app}: Scan must observe real app renders, not only display a toolbar`,
        );
        await toolbar.getByTitle("Inspect element", { exact: true }).click();
        await page.waitForFunction(
          () =>
            window.__REACT_SCAN__.ReactScanInternals.Store.inspectState.value.kind === "inspecting",
        );
        await page.locator("#root h1").click();
        await page.waitForFunction(
          () =>
            window.__REACT_SCAN__.ReactScanInternals.Store.inspectState.value.kind === "focused",
        );
        await toolbar.getByTitle("Inspect element", { exact: true }).click();
        await toolbar.getByTitle("Inspect element", { exact: true }).click();
        await page.waitForFunction(
          () =>
            window.__REACT_SCAN__.ReactScanInternals.Store.inspectState.value.kind ===
            "inspect-off",
        );
        for (const record of [...mounts, ...updates]) {
          assert.ok(Number.isFinite(record.actualDuration) && record.actualDuration >= 0);
          assert.ok(Number.isFinite(record.baseDuration) && record.baseDuration >= 0);
        }
        assert.ok(
          (await page.evaluate(() => document.documentElement.scrollWidth)) <= normalScrollWidth,
          `${name} ${app} profiling UI must not increase the app's existing horizontal overflow`,
        );
        assert.ok(
          await page
            .locator(".profile-banner")
            .evaluate((banner) => banner.scrollWidth <= banner.clientWidth),
          `${name} ${app} profiling banner overflows`,
        );
        await page.screenshot({ path: `benchmark/results/profile-${app}-${name}.png` });
        await page.evaluate(() => window.__benchmark.clear());
        assert.equal(await page.evaluate(() => window.__benchmark.records.length), 0);
        await page.getByRole("link", { name: "Open normal build", exact: true }).click();
        assert.equal(new URL(page.url()).pathname, `${prefix}${app}/`);
        await page.getByRole("heading", { name: "Incident triage" }).waitFor();
        assert.equal(await page.evaluate(() => window.__benchmark), undefined);
        await page.goto(new URL(`profile/${app}/`, base).href);
        await page.getByRole("link", { name: "All implementations", exact: true }).click();
        assert.equal(page.url(), base);
      }
      await page.getByText("How to profile these apps", { exact: true }).click();
      assert.deepEqual(await undersizedText(page), [], `${name} profiling help text is below 16px`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name} expanded profiling help overflows`,
      );
      await page.goto(base);
      await page.getByRole("link", { name: "Analyzer report" }).click();
      assert.equal(new URL(page.url()).pathname, `${prefix}analyzer/`);
      assert.equal(await page.getByRole("heading", { name: "React Compiler Analysis" }).count(), 1);
      assert.ok(
        (await page
          .locator(".log-line")
          .filter({ hasText: /Found \d+ TypeScript files/ })
          .count()) > 0,
        `${name} analyzer report must include verbose scan logs`,
      );
      assert.deepEqual(await undersizedText(page), [], `${name} analyzer text is below 16px`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name} analyzer report overflows horizontally`,
      );
      await page.goto(base);
      await page.getByRole("link", { name: "Compare output" }).first().click();
      assert.equal(new URL(page.url()).pathname, `${prefix}sources/`);
      assert.equal(await page.getByRole("heading", { name: "Compiled sources" }).count(), 1);
      assert.ok(await page.locator(".diff-line.added").count());
      assert.ok(await page.locator(".diff-line.removed").count());
      assert.deepEqual(await undersizedText(page), [], `${name} source text is below 16px`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name} source comparison overflows horizontally`,
      );
      await page.screenshot({ path: `benchmark/results/sources-${name}.png` });
      const compilerSource = await page.request.get(
        new URL(
          await page.getByRole("link", { name: "compiler source" }).getAttribute("href"),
          page.url(),
        ).href,
      );
      assert.equal(compilerSource.status(), 200);
      assert.match(await compilerSource.text(), /react\/compiler-runtime/);
      const baselineSource = await page.request.get(
        new URL(
          await page.getByRole("link", { name: "baseline source" }).getAttribute("href"),
          page.url(),
        ).href,
      );
      assert.equal(baselineSource.status(), 200);
      assert.doesNotMatch(await baselineSource.text(), /react\/compiler-runtime/);
      await page.locator("#module").selectOption("providers");
      await page.waitForURL(new URL("sources/compiler-baseline-providers.html", base).href);
      await page.locator("#pair").selectOption("manual-baseline");
      await page.waitForURL(new URL("sources/manual-baseline-providers.html", base).href);
      assert.equal((await page.locator(".diff-header span").allTextContents())[2], "providers.js");
      await page.goto(base);
      await page.getByRole("link", { name: "Latest benchmark report" }).click();
      assert.equal(new URL(page.url()).pathname, `${prefix}report/`);
      assert.equal(
        await page
          .getByRole("heading", {
            name: "Component work and committed updates",
          })
          .count(),
        1,
      );
      const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
      assert.equal(
        await page.getByText(report.evaluation.recommendation, { exact: true }).count(),
        1,
      );
      assert.deepEqual(
        await page
          .getByRole("navigation", { name: "Try profiling these apps" })
          .getByRole("link")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ["../profile/baseline/", "../profile/manual/", "../profile/compiler/"],
      );
      assert.deepEqual(
        await page.locator("article h2").allTextContents(),
        reportSections.map((section) => section.title),
      );
      const navigation = page.getByRole("navigation", { name: "Report sections", exact: true });
      assert.deepEqual(
        await navigation
          .getByRole("link")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        reportSections.map((section) => `#${section.id}`),
      );
      const sections = await page.locator("article h2").evaluateAll((headings) =>
        headings.map((heading) => {
          const tables = [];
          let text = "";
          for (
            let sibling = heading.nextElementSibling;
            sibling && sibling.tagName !== "H2";
            sibling = sibling.nextElementSibling
          ) {
            text += sibling.textContent;
            tables.push(...sibling.querySelectorAll("table"));
          }
          return {
            id: heading.id,
            text,
            headers: tables.map((table) =>
              [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
            ),
          };
        }),
      );
      assert.deepEqual(
        sections.map((section) => section.id),
        reportSections.map((section) => section.id),
      );
      assert.deepEqual(
        sections.map((section) => section.headers.length),
        [1, 4, 3, 9, report.rowMemo.status === "available" ? 10 : 9, 0],
      );
      for (const section of sections) {
        for (const headers of section.headers) {
          if (headers.includes("Row events ON / OFF")) continue;
          const indices = ["No memoization", "Manual memoization", "React Compiler"].map((label) =>
            headers.findIndex((header) => header.startsWith(label)),
          );
          assert.ok(
            indices[0] >= 0 && indices[0] < indices[1] && indices[1] < indices[2],
            `${name} ${section.id} comparison order differs`,
          );
        }
      }
      assert.doesNotMatch(
        sections[1].text,
        /Selection responsiveness|Filtering responsiveness|Favorite interaction/,
      );
      assert.match(sections[2].text, /67 visible incidents/);
      assert.match(sections[3].text, /200 \/ 34 \/ 34 \/ 200/);
      assert.match(sections[3].text, /no result change/);
      assert.match(sections[0].text, /Manual memoization remains effective/);
      assert.match(sections[1].text, /six runs covering all six app-order permutations/);
      const slowdownResponse = await page.request.get(new URL("report/slowdown.json", base).href);
      assert.equal(slowdownResponse.status(), 200);
      assert.deepEqual(analyzeUplt(await slowdownResponse.json()), report.load);
      assert.equal(
        await page.locator("article details").count(),
        0,
        "All comparison evidence must be expanded",
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "Load memory (normal production builds)", exact: true })
          .count(),
        1,
      );
      const memoryResponse = await page.request.get(new URL("report/load-memory.json", base).href);
      assert.equal(memoryResponse.status(), 200);
      assert.deepEqual(
        analyzeLoadMemory(await memoryResponse.json(), report.versions.playwrightChromium),
        report.loadMemory,
      );
      const filteringResponse = await page.request.get(
        new URL("report/filtering-latency.json", base).href,
      );
      assert.equal(filteringResponse.status(), 200);
      assert.deepEqual(
        analyzeFiltering(await filteringResponse.json(), report.versions.playwrightChromium),
        report.interactions.filtering,
      );
      assert.doesNotMatch(
        await page.locator("article").innerText(),
        /schema(?:[ -]?version)?[ :]*v?2/i,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "Why equal row counts do not mean equal work" })
          .count(),
        1,
      );
      for (const link of await page.locator("article a[href]").all()) {
        const href = await link.getAttribute("href");
        if (href.startsWith("#")) {
          assert.equal(await page.locator(href).count(), 1, `Missing report anchor: ${href}`);
          continue;
        }
        assert.equal(
          (await page.request.get(new URL(href, page.url()).href)).status(),
          200,
          `Broken report link: ${href}`,
        );
      }
      if (report.rowCaching.status === "recognized") {
        assert.equal(await page.locator("article pre").count(), 3);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} expanded code excerpts overflow`,
        );
      }
      const measurementResponse = await page.request.get(
        new URL("report/measurements.json", base).href,
      );
      assert.equal(measurementResponse.status(), 200);
      const measurements = await measurementResponse.json();
      assert.equal(measurements.schemaVersion, 2);
      for (const app of ["compiler", "manual", "baseline"]) {
        const records = measurements.repetitions[0][app].actions.flatMap(
          (action) => action.records,
        );
        assert.ok(records.some((record) => record.id === "root"));
        assert.ok(records.every((record) => Number.isFinite(record.baseDuration)));
        assert.equal(measurements.repetitions[0][app].paths.filtering.actions.length, 4);
      }
      assert.deepEqual(await undersizedText(page), [], `${name} benchmark text is below 16px`);
      const reportFontSizes = await page.evaluate(() => ({
        paragraphs: [...document.querySelectorAll(".report-body p")].map((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
        tables: [...document.querySelectorAll(".report-body table")].map((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
      }));
      assert.ok(
        [...reportFontSizes.paragraphs, ...reportFontSizes.tables].every((size) => size >= 16),
        `${name} report text must be at least 16px: ${JSON.stringify(reportFontSizes)}`,
      );
      const tableWidths = await page.locator("article table").evaluateAll((tables) =>
        tables.map((table) => ({
          table: table.getBoundingClientRect().width,
          header: table.tHead?.getBoundingClientRect().width ?? 0,
        })),
      );
      assert.ok(
        tableWidths.every(({ table, header }) => header >= table - 2),
        `${name} table header must fill the table: ${JSON.stringify(tableWidths)}`,
      );
      assert.equal(
        await page.locator("article img").evaluateAll(async (images) => {
          await Promise.all(images.map((image) => image.decode()));
          return images.filter((image) => image.naturalWidth > 0).length;
        }),
        3,
      );
      if (process.env.BENCHMARK_RUN_ID)
        assert.ok(
          (
            await page
              .getByRole("link", { name: new RegExp(`CI run ${process.env.BENCHMARK_RUN_ID}`) })
              .getAttribute("href")
          )?.endsWith(`/actions/runs/${process.env.BENCHMARK_RUN_ID}`),
        );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `benchmark/results/report-${name}.png` });
      for (const id of ["row-selection", "query-filtering"]) {
        await navigation.locator(`a[href="#${id}"]`).click();
        assert.equal(new URL(page.url()).hash, `#${id}`);
        const heading = await page.locator(`#${id}`).boundingBox();
        assert.ok(
          heading.y >= 0 && heading.y + heading.height <= height,
          `${name} ${id} anchor is occluded`,
        );
        await page.screenshot({ path: `benchmark/results/report-${id}-${name}.png` });
      }
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name} report overflows horizontally`,
      );
      if (report.rowMemo.status === "available") {
        await page.getByRole("link", { name: "Full row-memo report" }).click();
        assert.equal(new URL(page.url()).pathname, `${prefix}report/row-memo/report.html`);
        assert.equal(
          await page
            .getByRole("heading", { name: "Manual row memo ablation", exact: true })
            .count(),
          1,
        );
        assert.equal(await page.locator("table").count(), 3);
        const raw = await page.request.get(new URL("measurements.json", page.url()).href);
        assert.equal(raw.status(), 200);
        assert.equal((await raw.json()).sourceFingerprint, report.provenance.sourceFingerprint);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} ablation report overflows`,
        );
      } else {
        assert.equal(await page.getByText(/Ablation unavailable for this build/).count(), 1);
        assert.equal(
          (await page.request.get(new URL("report/row-memo/report.html", base).href)).status(),
          404,
        );
      }
      assert.deepEqual(errors, [], `${name} browser errors`);
      assert.deepEqual(externalRequests, [], `${name} profiling must not contact third parties`);
      assert.deepEqual(failedResources, [], `${name} resource failures`);
      await page.close();
    }
    await checkDevtools(browser, base);
    console.log(
      "Pages chooser, source comparison, analyzer and benchmark reports, and all six app routes passed desktop/mobile navigation checks.",
    );
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
}

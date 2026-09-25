import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";

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
      }
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
      assert.equal(await page.locator("article table").count(), 7);
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
      await page.screenshot({ path: `benchmark/results/report-${name}.png` });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name} report overflows horizontally`,
      );
      assert.deepEqual(errors, [], `${name} browser errors`);
      await page.close();
    }
    console.log(
      "Pages chooser, analyzer and benchmark reports, and all three apps passed desktop/mobile navigation checks.",
    );
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
}

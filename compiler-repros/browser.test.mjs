import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { publishComparison } from "./publish.mjs";
import { directory } from "./run.mjs";

test("public HTML works offline with desktop/mobile filters, evidence tabs, and links", async (context) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "compiler-repros-browser-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const report = publishComparison(outputDirectory);
  assert.deepEqual(report.failures, []);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  mkdirSync(join(directory, "results"), { recursive: true });
  const differences = report.cases.filter((fixture) =>
    Object.values(fixture.comparisons).some(
      (comparison) => comparison.cacheMismatch || comparison.slotsMismatch,
    ),
  );
  const diagnosticFixtures = report.cases.filter((fixture) =>
    ["babel", "oxc", "swc"].some((compiler) => fixture[compiler].diagnostics.length),
  );

  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    const networkRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) networkRequests.push(request.url());
    });
    await page.goto(pathToFileURL(join(outputDirectory, "index.html")).href);
    await page.getByRole("heading", { name: "Compiler compatibility" }).waitFor();
    assert.equal(await page.locator("[data-case]").count(), report.cases.length);
    assert.equal(
      await page.getByRole("combobox", { name: "Filter outcomes" }).inputValue(),
      "differences",
    );
    assert.deepEqual(await page.locator(".metrics span").allTextContents(), [
      "isolated fixtures",
      "Compiler cache differences",
    ]);
    assert.deepEqual(
      await page
        .locator("[data-row]:visible")
        .evaluateAll((rows) => rows.map((row) => row.dataset.row)),
      differences.map((fixture) => fixture.id),
    );
    assert.equal(
      await page.locator("#visible-count").textContent(),
      `${differences.length} of ${report.cases.length}`,
    );
    assert.equal(
      await page.getByRole("columnheader", { name: "SWC cache", exact: true }).count(),
      1,
    );
    if (name === "mobile") {
      const cacheCell = await page
        .locator("[data-row]:visible")
        .first()
        .locator("td")
        .first()
        .boundingBox();
      const tableFrame = await page.locator(".table-scroll").boundingBox();
      assert.ok(
        cacheCell.x + 36 < tableFrame.x + tableFrame.width,
        "Mobile table must show the first cache result without scrolling",
      );
    }
    assert.deepEqual(
      await page.locator(".metrics span").evaluateAll((labels) => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        return labels
          .filter((label) => {
            context.font = getComputedStyle(label).font;
            return (
              label.clientWidth <
              Math.max(
                ...label.textContent.split(/\s+/).map((word) => context.measureText(word).width),
              )
            );
          })
          .map((label) => label.textContent);
      }),
      [],
      `${name} summary labels split words`,
    );
    assert.equal(
      await page.locator("#input-code").textContent(),
      report.cases.find((fixture) => fixture.id === new URL(page.url()).hash.slice(1)).source,
    );
    const finding = page.getByRole("region", { name: "Key finding", exact: true });
    assert.equal(await finding.count(), 1);
    assert.equal(
      await finding
        .getByRole("heading", {
          name: "SWC avoids a redundant-suppression bailout",
          exact: true,
        })
        .count(),
      1,
    );
    assert.ok((await finding.textContent()).includes("not proven redundancy detection"));
    const evidenceIds = [
      "valid-hooks-redundant-suppression",
      "invalid-hooks-with-suppression",
      "invalid-hooks-no-suppression",
    ];
    assert.deepEqual(
      await finding
        .locator("[data-evidence-case]")
        .evaluateAll((links) => links.map((link) => link.dataset.evidenceCase)),
      evidenceIds,
    );
    assert.equal(
      await page
        .locator('[data-row="valid-hooks-redundant-suppression"]')
        .getByText("Suppression opt-out", { exact: true })
        .count(),
      2,
    );
    await page.screenshot({
      path: join(directory, "results", `report-${name}.png`),
      fullPage: true,
    });

    await page.getByRole("combobox", { name: "Filter outcomes" }).selectOption("bailouts");
    assert.deepEqual(
      await page
        .locator("[data-row]:visible")
        .evaluateAll((rows) => rows.map((row) => row.dataset.row)),
      diagnosticFixtures.map((fixture) => fixture.id),
    );
    assert.ok(
      diagnosticFixtures.length > differences.length,
      "Diagnostic-only fixtures must not appear in Differences",
    );
    await page.getByRole("combobox", { name: "Filter outcomes" }).selectOption("differences");
    assert.equal(await page.locator("[data-row]:visible").count(), differences.length);
    await page.getByRole("searchbox", { name: "Search fixtures" }).fill("no-such-fixture");
    assert.equal(await page.locator("#empty-row").isVisible(), true);
    await page.getByRole("searchbox", { name: "Search fixtures" }).fill("");
    await page.getByRole("combobox", { name: "Filter outcomes" }).selectOption("all");
    await page.getByRole("button", { name: "computed-template-key", exact: true }).click();
    await page.getByRole("tab", { name: "Input", exact: true }).click();
    assert.ok((await page.locator("#input-code").textContent()).includes("styleKeys"));
    await page.getByRole("tab", { name: "Input", exact: true }).press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { name: "Diff", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    assert.ok(await page.locator("#diff-code .diff-line").count());
    await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
    assert.ok((await page.locator("#left-diagnostics").textContent()).length);
    const inspected = report.cases.find((fixture) => fixture.id === "computed-template-key");
    for (const pair of ["babel-oxc", "babel-swc", "oxc-swc"]) {
      const [left, right] = pair.split("-");
      await page.getByRole("combobox", { name: "Compare compilers" }).selectOption(pair);
      await page.getByRole("tab", { name: "Compiler output", exact: true }).click();
      assert.equal(await page.locator("#left-code").textContent(), inspected[left].code);
      assert.equal(await page.locator("#right-code").textContent(), inspected[right].code);
      await page.getByRole("tab", { name: "Diff", exact: true }).click();
      assert.deepEqual(
        await page.locator("#diff-code .diff-line").allTextContents(),
        inspected.codegenDiffs[pair].split("\n"),
      );
      const diff = await page.getByRole("link", { name: "Diff", exact: true }).getAttribute("href");
      assert.ok(existsSync(join(outputDirectory, diff)));
      assert.equal(diff, `${inspected.id}.${pair === "babel-oxc" ? "diff" : `${pair}.diff`}`);
      await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
      assert.ok(
        (await page.locator("#right-diagnostic-name").textContent()).includes(right.toUpperCase()),
      );
    }
    await page.getByRole("link", { name: "Control", exact: true }).click();
    assert.equal(await page.locator("#case-title").textContent(), "computed-member-key-control");
    await page.getByRole("tab", { name: "Compiler output", exact: true }).click();
    assert.ok((await page.locator("#left-code").textContent()).includes("react/compiler-runtime"));
    const source = await page
      .getByRole("link", { name: "Source", exact: true })
      .getAttribute("href");
    assert.ok(existsSync(join(outputDirectory, source)));
    for (const id of evidenceIds) {
      await page.getByRole("combobox", { name: "Filter outcomes" }).selectOption("differences");
      await page.getByRole("searchbox", { name: "Search fixtures" }).fill("no-such-fixture");
      await finding.locator(`[data-evidence-case="${id}"]`).click();
      assert.equal(await page.locator("#case-title").textContent(), id);
      assert.equal(await page.locator(`[data-row="${id}"]`).isVisible(), true);
      assert.equal(await page.getByRole("searchbox", { name: "Search fixtures" }).inputValue(), "");
      assert.equal(
        await page.getByRole("combobox", { name: "Compare compilers" }).inputValue(),
        "babel-swc",
      );
      assert.equal(new URL(page.url()).hash, `#${id}`);
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `${name} page overflow`,
    );
    assert.deepEqual(errors, [], `${name} browser errors`);
    assert.deepEqual(networkRequests, [], `${name} external requests`);
    await page.close();
  }
});

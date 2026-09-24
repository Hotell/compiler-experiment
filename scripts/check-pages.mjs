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

await new Promise((done) => server.listen(0, "127.0.0.1", done));
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
        await page.getByRole("heading", { name: "Choose an implementation" }).count(),
        1,
      );
      assert.equal(
        await page
          .locator("img")
          .evaluateAll(
            (images) => images.filter((image) => image.complete && image.naturalWidth > 0).length,
          ),
        3,
        "chooser previews must load",
      );
      if (app === "compiler") {
        await page.screenshot({ path: `benchmark/results/pages-${name}.png` });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} chooser overflows horizontally`,
        );
      }
      await page.locator(`.route[href="./${app}/"]`).click();
      assert.equal(new URL(page.url()).pathname, `${prefix}${app}/`);
      await page.getByRole("heading", { name: "Incident triage" }).waitFor();
      assert.equal(await page.getByRole("row").count(), 201, `${app} incidents must render`);
    }
    assert.deepEqual(errors, [], `${name} browser errors`);
    await page.close();
  }
  console.log(
    "Pages chooser, previews and all three nested apps passed desktop/mobile navigation checks.",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

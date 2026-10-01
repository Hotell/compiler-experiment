import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { build } from "vite";

const require = createRequire(import.meta.url);

export async function checkDevtools(browser, base) {
  const builds = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: require.resolve("react-devtools-inline/backend"),
        name: "ReactDevtoolsBackend",
        formats: ["iife"],
      },
    },
  });
  const output = (Array.isArray(builds) ? builds : [builds]).flatMap((result) => result.output);
  assert.equal(output.length, 1, "DevTools test backend must be a single in-memory script");
  assert.equal(output[0].type, "chunk");
  const backendSource = output[0].code;
  for (const [app, profiling] of [
    ["compiler", true],
    ["manual", true],
    ["baseline", true],
    ["baseline", false],
  ]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript({
        content: `(() => {
          ${backendSource}
          const backend = ReactDevtoolsBackend;
          const events = [];
          let receive;
          backend.initialize(window);
          const bridge = backend.createBridge(window, {
            listen(callback) { receive = callback; return () => {}; },
            send(event, payload) {
              events.push({ event, payload });
              if (event === "getSavedPreferences")
                queueMicrotask(() => receive({ event: "savedPreferences", payload: { componentFilters: [] } }));
            }
          });
          window.__devtoolsCheck = {
            events,
            hook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
            send: (event, payload) => receive({ event, payload })
          };
          backend.activate(window, { bridge });
        })();`,
      });
      const response = await page.goto(new URL(`${profiling ? "profile/" : ""}${app}/`, base).href);
      assert.equal(response.status(), 200);
      await page.getByRole("heading", { name: "Incident triage" }).waitFor();
      assert.deepEqual(errors, [], `${app} DevTools initialization errors`);
      assert.equal(
        await page.evaluate(
          () => window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === window.__devtoolsCheck.hook,
        ),
        true,
        "Scan must preserve an already-installed React DevTools hook",
      );
      if (profiling)
        await page
          .locator("#react-scan-root")
          .getByTitle("Inspect element", { exact: true })
          .waitFor();
      await page.waitForFunction(() =>
        window.__devtoolsCheck.events.some((entry) => entry.event === "operations"),
      );
      const rendererID = await page.evaluate(() => {
        const renderers = [...window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.keys()];
        if (renderers.length !== 1) throw new Error("Expected one DevTools renderer");
        window.__devtoolsCheck.send("startProfiling", { recordChangeDescriptions: false });
        return renderers[0];
      });
      await page.waitForFunction(() =>
        window.__devtoolsCheck.events.some(
          (entry) => entry.event === "profilingStatus" && entry.payload === true,
        ),
      );
      await page.getByRole("button", { name: "Open INC-0001", exact: true }).click();
      await page.getByRole("dialog", { name: "Incident detail" }).waitFor();
      await page.getByRole("button", { name: "Close detail" }).click();
      await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
      await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).waitFor();
      await page.evaluate(() => window.__devtoolsCheck.send("stopProfiling"));
      await page.waitForFunction(
        () =>
          window.__devtoolsCheck.events.filter((entry) => entry.event === "profilingStatus").at(-1)
            ?.payload === false,
      );
      await page.evaluate(
        (id) => window.__devtoolsCheck.send("getProfilingData", { rendererID: id }),
        rendererID,
      );
      await page.waitForFunction(() =>
        window.__devtoolsCheck.events.some((entry) => entry.event === "profilingData"),
      );
      const data = await page.evaluate(
        () =>
          window.__devtoolsCheck.events.find((entry) => entry.event === "profilingData").payload,
      );
      assert.equal(data.rendererID, rendererID);
      if (profiling) {
        assert.equal(
          data.dataForRoots.length,
          1,
          `${app}: DevTools must capture the profiled root`,
        );
        const root = data.dataForRoots[0];
        assert.ok(
          root.initialTreeBaseDurations.length > 0,
          `${app}: missing DevTools base durations`,
        );
        assert.ok(
          root.initialTreeBaseDurations.every(
            ([, duration]) => Number.isFinite(duration) && duration >= 0,
          ),
        );
        assert.ok(
          root.commitData.length >= 3,
          `${app}: DevTools must record selection, close and favorite commits`,
        );
        for (const commit of root.commitData) {
          assert.ok(Number.isFinite(commit.duration) && commit.duration >= 0);
          assert.ok(commit.fiberActualDurations.length > 0, `${app}: missing component durations`);
          assert.ok(
            commit.fiberActualDurations.every(
              ([, duration]) => Number.isFinite(duration) && duration >= 0,
            ),
          );
        }
      } else {
        assert.deepEqual(data.dataForRoots, [], "Normal production must not expose profiling data");
      }
      assert.deepEqual(errors, [], `${app} DevTools errors`);
    } finally {
      await context.close();
    }
  }
  console.log(
    "Real React DevTools backend recorded all three profiling apps; normal-build control remains uninstrumented.",
  );
}

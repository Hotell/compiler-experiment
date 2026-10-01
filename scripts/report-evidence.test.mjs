import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ablationFiles,
  ablationMarkdown,
  evaluateComparison,
  inspectRowCaching,
  loadAblationEvidence,
  rowComparison,
  selectionEvidence,
} from "./report-evidence.mjs";
import { hashFiles, measurementFiles, validateProvenance } from "./benchmark-provenance.mjs";

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "report-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("evaluation compares all three approaches without declaring a timing winner", () => {
  const result = evaluateComparison({
    versions: { react: "test" },
    deltas: { js: { raw: { bytes: 8167, percent: 3.44 } } },
    interactions: {
      selection: {
        baseline: { medianDomMs: 8, medianPaintMs: 20 },
        manual: { medianDomMs: 4, medianPaintMs: 11 },
        compiler: { medianDomMs: 3, medianPaintMs: 10 },
      },
    },
  });
  assert.match(result.recommendation, /Manual memoization remains effective/);
  assert.match(result.recommendation, /3\.44% more minified JavaScript/);
  assert.match(result.recommendation, /no demonstrated selection-speed winner/i);
  assert.match(result.rationale, /lower bundle cost/);
  assert.match(result.rationale, /not.*equivalent.*memory/i);
  assert.match(result.rationale, /8 ms.*No memoization/);
  assert.match(result.rationale, /4 ms.*Manual memoization/);
  assert.match(result.rationale, /3 ms.*React Compiler/);
  assert.match(result.rationale, /do not establish a repeatable speed winner/);
  assert.doesNotMatch(result.recommendation, /compiler.*(?:wins|faster)|manual.*(?:wins|faster)/i);
});

test("recommendation follows measured bundle direction rather than always favoring manual", () => {
  const selection = Object.fromEntries(
    ["baseline", "manual", "compiler"].map((app) => [app, { medianDomMs: 4, medianPaintMs: 10 }]),
  );
  for (const [bytes, percent, phrase] of [
    [-420, -0.18, "0.18% less minified JavaScript"],
    [0, 0, "the same amount of minified JavaScript"],
  ]) {
    const result = evaluateComparison({
      versions: { react: "test" },
      interactions: { selection },
      deltas: { js: { raw: { bytes, percent } } },
    });
    assert.ok(result.recommendation.includes(phrase));
    assert.doesNotMatch(result.rationale, /manual.*lower bundle cost/i);
  }
});

test("UPLT requires six balanced runs and preserves all samples", async () => {
  const { analyzeUplt } = await import("./report-evidence.mjs");
  const { loadMemoryOrders } = await import("../benchmark/load-memory.mjs");
  const times = [120, 90, 130, 100, 140, 110];
  const raw = {
    cpuRate: 4,
    repetitions: loadMemoryOrders.map((order, index) => ({
      order,
      ...Object.fromEntries(
        ["baseline", "manual", "compiler"].map((app) => [app, { uptlMs: times[index] }]),
      ),
    })),
  };
  const before = JSON.stringify(raw);
  const result = analyzeUplt(raw);
  assert.equal(result.baseline.medianMs, 115);
  assert.deepEqual(result.baseline.samplesMs, times);
  assert.equal(result.manual.samplesMs.length, 6);
  assert.equal(result.compiler.samplesMs.length, 6);
  assert.equal(JSON.stringify(raw), before);
  for (const mutate of [
    (value) => {
      value.repetitions.pop();
    },
    (value) => {
      value.cpuRate = 1;
    },
    (value) => {
      value.repetitions[0].baseline.uptlMs = 0;
    },
    (value) => {
      value.repetitions[0].manual.uptlMs = Infinity;
    },
    (value) => {
      value.repetitions[3].order = value.repetitions[0].order;
    },
  ]) {
    const invalid = structuredClone(raw);
    mutate(invalid);
    assert.throws(() => analyzeUplt(invalid));
  }
});

test("filtering validates per-step trials and distinguishes unchanged results from zero time", async () => {
  const { analyzeFiltering } = await import("./report-evidence.mjs");
  const { filteringProtocol } = await import("../benchmark/filtering.mjs");
  const apps = ["baseline", "manual", "compiler"];
  const raw = {
    schemaVersion: 1,
    browser: "test",
    cpuRate: 4,
    protocol: filteringProtocol,
    repetitions: Array.from({ length: 20 }, (_, index) => ({
      order: [...apps.slice(index % 3), ...apps.slice(0, index % 3)],
      ...Object.fromEntries(
        apps.map((app) => [
          app,
          filteringProtocol.steps.map((step) => ({
            ...step,
            resultIds:
              step.query.length > 1 ? filteringProtocol.filteredIds : filteringProtocol.initialIds,
            domMs: step.resultsChanged ? index + 1 : null,
            paintMs: index + 10,
          })),
        ]),
      ),
    })),
  };
  const before = JSON.stringify(raw);
  const result = analyzeFiltering(raw, "test");
  assert.equal(result.apps.baseline[0].medianDomMs, null);
  assert.equal(result.apps.baseline[1].medianDomMs, 10.5);
  assert.equal(result.apps.baseline[1].p90DomMs, 18);
  assert.equal(result.apps.baseline[2].p90DomMs, null);
  assert.equal(result.apps.baseline[3].medianPaintMs, 19.5);
  assert.equal(result.apps.manual[0].runs.length, 20);
  assert.equal(JSON.stringify(raw), before);
  for (const mutate of [
    (value) => {
      value.repetitions.pop();
    },
    (value) => {
      value.browser = "other";
    },
    (value) => {
      value.cpuRate = 1;
    },
    (value) => {
      value.repetitions[0].baseline[0].domMs = 0;
    },
    (value) => {
      value.repetitions[0].baseline[1].domMs = null;
    },
    (value) => {
      value.repetitions[0].baseline[1].resultIds.reverse();
    },
    (value) => {
      value.repetitions[0].baseline[2].query = "different";
    },
    (value) => {
      value.protocol.initialState.queue = "Platform";
    },
    (value) => {
      value.repetitions[0].order = ["baseline", "baseline", "manual"];
    },
  ]) {
    const invalid = structuredClone(raw);
    mutate(invalid);
    assert.throws(() => analyzeFiltering(invalid, "test"));
  }
});

test("row comparisons count events and accept improved compiler bailouts", () => {
  assert.equal(rowComparison(67, 1, 67), "M records fewer row events");
  assert.equal(rowComparison(0, 1, 67), "C records fewer row events");
  assert.equal(rowComparison(1, 1, 67), "C = M; 66 fewer row events than B");
  assert.equal(rowComparison(1, 1, 1), "C = M on row events");
  const actions = Object.fromEntries(
    ["compiler", "manual", "baseline"].map((app) => [
      app,
      [
        {
          name: "select incident",
          rowRenders: app === "manual" ? 1 : 67,
          openButtonRenders: app === "baseline" ? 67 : 0,
          favoriteButtonRenders: app === "baseline" ? 67 : 0,
        },
      ],
    ]),
  );
  assert.match(
    selectionEvidence(actions),
    /No memoization: 67 rows.*Manual memoization: 1 rows.*React Compiler: 67 rows/,
  );
  assert.match(selectionEvidence(actions), /Equal row counts do not mean equal CPU cost/);
  actions.compiler[0].rowRenders = 1;
  assert.match(selectionEvidence(actions), /does not show the previously observed/);
  assert.doesNotMatch(selectionEvidence(actions), /record the same number of row events here/);
});

test("comparison tables keep baseline first and preserve missing versus measured zero", async () => {
  const { comparisonTable, reportSections } = await import("./report-markdown.mjs");
  const markdown = comparisonTable([
    { label: "Latency (ms)", values: { baseline: 8, manual: 4, compiler: 3 }, relative: true },
    { label: "Zero reference", values: { baseline: 0, manual: 1, compiler: 0 }, relative: true },
    { label: "Profiler (ms)", values: { baseline: null, manual: 0, compiler: null } },
  ]).join("\n");
  assert.match(markdown, /Metric \| No memoization \| Manual memoization \| React Compiler/);
  assert.match(markdown, /4\.0 \(-4\.0; -50\.0%\)/);
  assert.match(markdown, /3\.0 \(-5\.0; -62\.5%\)/);
  assert.match(markdown, /1\.0 \(\+1\.0; n\/a\)/);
  assert.match(markdown, /not observed \| 0\.0 \| not observed/);
  assert.doesNotMatch(markdown, /NaN|Infinity/);
  assert.deepEqual(
    reportSections.map((section) => section.id),
    ["overview", "page-load", "row-selection", "query-filtering", "evidence", "methodology"],
  );
});

test("cache explanations quote real source or explicitly request reassessment", () => {
  const compiler = `
function IncidentList() {
  if ($[1] !== incidents || $[2] !== selectedId) {
    t2 = incidents.map(t3);
  } else { t2 = $[3]; }
}
function IncidentRow() {
  if ($[1] !== onSelect) {
    t2 = _jsx(OpenIncidentButton, { onSelect });
  } else { t2 = $[2]; }
}`;
  const manual = "const IncidentRow = true ? memo(IncidentRowImpl) : IncidentRowImpl;";
  const evidence = inspectRowCaching(compiler, manual);
  assert.equal(evidence.status, "recognized");
  assert.equal(evidence.excerpts.length, 3);
  assert.ok(
    evidence.excerpts.every(({ code }) => compiler.includes(code) || manual.includes(code)),
  );
  assert.match(evidence.explanation, /caller-side JSX caching/);
  for (const source of [
    "function IncidentRow() {}",
    compiler.replaceAll("incidents.map(", "cachedRows("),
  ]) {
    const changed = inspectRowCaching(source, manual);
    assert.equal(changed.status, "unrecognized");
    assert.equal(changed.excerpts, undefined);
    assert.match(changed.explanation, /Generated-code pattern changed/);
  }
  assert.throws(() => inspectRowCaching("function {", manual), /Invalid compiled/);
});

test("absent or stale ablation is explicit and produces no broken links", (t) => {
  const directory = temporary(t);
  const report = {
    provenance: { sourceFingerprint: "a".repeat(64) },
    versions: { playwrightChromium: "chromium", react: "19.3.0" },
  };
  const missing = loadAblationEvidence(report, directory);
  assert.equal(missing.status, "unavailable");
  assert.match(ablationMarkdown(missing).join("\n"), /Ablation unavailable for this build/);
  assert.doesNotMatch(ablationMarkdown(missing).join("\n"), /\]\(/);
  writeFileSync(join(directory, "comparison.json"), "{}");
  assert.throws(() => loadAblationEvidence(report, directory), /Incomplete ablation/);
  for (const file of ablationFiles) writeFileSync(join(directory, file), "{}");
  for (const mismatch of [
    { sourceFingerprint: "b".repeat(64), browser: "chromium", reactVersion: "19.3.0" },
    { sourceFingerprint: "a".repeat(64), browser: "other", reactVersion: "19.3.0" },
    { sourceFingerprint: "a".repeat(64), browser: "chromium", reactVersion: "other" },
  ]) {
    writeFileSync(join(directory, "measurements.json"), JSON.stringify(mismatch));
    writeFileSync(join(directory, "comparison.json"), JSON.stringify(mismatch));
    const stale = loadAblationEvidence(report, directory);
    assert.equal(stale.status, "unavailable");
    assert.match(stale.reason, /provenance differs/);
    assert.doesNotMatch(ablationMarkdown(stale).join("\n"), /\]\(/);
  }
});

test("malformed matching ablation fails rather than appearing as a successful experiment", (t) => {
  const directory = temporary(t);
  const sourceFingerprint = "a".repeat(64);
  for (const file of ablationFiles)
    writeFileSync(
      join(directory, file),
      JSON.stringify({ sourceFingerprint, browser: "test", reactVersion: "test" }),
    );
  assert.throws(
    () =>
      loadAblationEvidence(
        {
          provenance: { sourceFingerprint },
          versions: { playwrightChromium: "test", react: "test" },
        },
        directory,
      ),
    /unsupported schema/,
  );
});

test("main provenance rejects mixed measurements and changed sources", (t) => {
  const directory = temporary(t);
  for (const file of measurementFiles) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), file);
  }
  const provenance = {
    schemaVersion: 1,
    sourceFingerprint: "a".repeat(64),
    measurements: hashFiles(directory, measurementFiles),
  };
  validateProvenance(provenance, directory, "a".repeat(64));
  assert.throws(() => validateProvenance(provenance, directory, "b".repeat(64)), /sources changed/);
  writeFileSync(join(directory, "measurements.json"), "from a different run");
  assert.throws(
    () => validateProvenance(provenance, directory, "a".repeat(64)),
    /measurements changed/,
  );
});

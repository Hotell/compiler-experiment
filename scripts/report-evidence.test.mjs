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

test("neutral headline uses minified JS percentage relative to manual, not gzip or total bytes", () => {
  for (const [bytes, percent, expected] of [
    [8167, 3.44, "compiler ships 3.44% more minified JavaScript."],
    [-420, -0.18, "compiler ships 0.18% less minified JavaScript."],
    [0, 0, "compiler and manual ship the same amount of minified JavaScript."],
  ]) {
    const result = evaluateComparison({
      deltas: {
        js: { raw: { bytes, percent }, gzip: { bytes: -99, percent: -88 } },
        total: { raw: { bytes: -77, percent: -66 }, gzip: { bytes: -55, percent: -44 } },
      },
      versions: { react: "test" },
      interactions: {
        selection: {
          compiler: { medianDomMs: 3, medianPaintMs: 10 },
          manual: { medianDomMs: 4, medianPaintMs: 11 },
        },
      },
    });
    assert.equal(
      result.recommendation,
      `No demonstrated selection-speed winner between compiler and manual; ${expected}`,
    );
    assert.doesNotMatch(result.recommendation, /gzip|kB|parse time|parsing time/);
    assert.match(result.rationale, /3 ms \(compiler\) vs 4 ms \(manual\)/);
    assert.match(result.rationale, /do not establish a repeatable speed winner/);
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
  assert.match(selectionEvidence(actions), /\*\*67 \/ 1 \/ 67\*\*/);
  assert.match(selectionEvidence(actions), /Equal row counts do not mean equal CPU cost/);
  actions.compiler[0].rowRenders = 1;
  assert.match(selectionEvidence(actions), /does not show the previously observed/);
  assert.doesNotMatch(selectionEvidence(actions), /record the same number of row events here/);
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

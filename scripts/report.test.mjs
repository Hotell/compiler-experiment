import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { lexer } from "marked";
import {
  countProfileRecords,
  summarizeProfileSamples,
  validateProfileRecords,
} from "./profile-counts.mjs";
import "./profile-counts.test.mjs";
import {
  ablationMarkdown,
  analyzeFiltering,
  analyzeUplt,
  evaluateComparison,
  inspectRowCaching,
  loadAblationEvidence,
  selectionEvidence,
} from "./report-evidence.mjs";
import { hashFiles, validateProvenance } from "./benchmark-provenance.mjs";
import { analyzeLoadMemory, loadMemoryMarkdown } from "./load-memory.mjs";
import { renderComparison, reportSections } from "./report-markdown.mjs";
import { filteringProtocol } from "../benchmark/filtering.mjs";

test("comparison explains load, Lighthouse, CPU traces and the decision", () => {
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const slowdown = JSON.parse(readFileSync("benchmark/results/slowdown.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  assert.deepEqual(report.load, analyzeUplt(slowdown));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.versions.react, "19.3.0");
  assert.match(markdown, /React 19\.3\.0 profiling fiber/);
  const tables = lexer(markdown, { gfm: true }).filter((token) => token.type === "table");
  const sections = new Map();
  let current;
  for (const token of lexer(markdown, { gfm: true })) {
    if (token.type === "heading" && token.depth === 2) {
      current = token.text;
      sections.set(current, []);
    } else if (token.type === "table") sections.get(current).push(token);
  }
  assert.deepEqual(
    [...sections.keys()],
    reportSections.map((section) => section.title),
  );
  assert.equal(sections.get("Overview").length, 1);
  assert.equal(sections.get("Page load").length, 4);
  assert.equal(sections.get("Row selection").length, 3);
  assert.equal(sections.get("Query filtering").length, 9);
  assert.equal(
    sections.get("Additional evidence").length,
    report.rowMemo.status === "available" ? 10 : 9,
  );
  assert.equal(markdown, renderComparison(report));
  for (const table of tables) {
    assert.ok(table.rows.every((row) => row.length === table.header.length));
    const headers = table.header.map((cell) => cell.text);
    if (!headers.includes("Row events ON / OFF")) {
      const indices = ["No memoization", "Manual memoization", "React Compiler"].map((label) =>
        headers.findIndex((header) => header.startsWith(label)),
      );
      assert.ok(indices[0] >= 0 && indices[0] < indices[1] && indices[1] < indices[2]);
    }
  }
  for (const { id } of reportSections) assert.ok(markdown.includes(`](#${id})`));
  const loadSection = markdown.split("## Page load\n")[1].split("## Row selection\n")[0];
  assert.match(loadSection, /Initial-load production bytes/);
  assert.match(loadSection, /User-perceived load time/);
  assert.match(loadSection, /six runs covering all six app-order permutations/);
  assert.match(loadSection, /Run 1 \/ 2 \/ 3 \/ 4 \/ 5 \/ 6 \(ms\)/);
  assert.match(loadSection, /Lighthouse/);
  assert.match(loadSection, /Load memory/);
  assert.doesNotMatch(
    loadSection,
    /favorite-|Selection responsiveness|Filtering responsiveness|Post-GC JS heap/,
  );
  const selectionSection = markdown.split("## Row selection\n")[1].split("## Query filtering\n")[0];
  assert.match(selectionSection, /Selection responsiveness/);
  assert.doesNotMatch(selectionSection, /favorite-.*cpuprofile|filtering-latency\.json/);
  assert.match(markdown, /JS gzip \(kB\)/);
  assert.match(markdown, /Row render-work events/);
  assert.match(markdown, /Queue render-work events/);
  assert.doesNotMatch(markdown, /C \/ M \/ B|<details>|fewest JS-active sampled/);
  assert.doesNotMatch(markdown, /schema(?:[ -]?version)?[ :]*[vV]?2|does less row work/i);
  assert.match(markdown, /not milliseconds, equal-cost CPU operations, DOM mutations/);
  assert.match(markdown, /JS-active sampled time/);
  assert.match(markdown, /BASE \(baseDuration\).*estimate/);
  assert.match(markdown, /BASE minus ACTUAL is not measured savings/);
  assert.match(markdown, /medianBaseDurationMs/);
  assert.match(markdown, /null means no matching callback.*0 is a measured zero/);
  assert.match(markdown, /Overlapping root\/parent\/child durations are never summed/);
  assert.match(markdown, /\[rootId, rootGeneration, commitSequence\]/);
  assert.match(markdown, /\[measurements\.json\]\(measurements\.json\)/);
  assert.ok(report.evaluation?.recommendation);
  assert.match(report.evaluation.recommendation, /Manual memoization remains effective/);
  assert.match(report.evaluation.recommendation, /no demonstrated selection-speed winner/i);
  assert.doesNotMatch(markdown, /Compare memoization by scenario, not a single overall winner/);
  assert.deepEqual(report.evaluation, evaluateComparison(report));
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(report.bundles[app].total.gzip > 0);
    assert.ok(report.actions[app].find((action) => action.name === "select incident"));
    assert.ok(report.load[app].medianMs > 0);
    assert.equal(report.load[app].samplesMs.length, 6);
    assert.equal(report.interactions.selection[app].runs.length, 20);
    assert.ok(report.interactions.selection[app].medianDomMs > 0);
    assert.ok(report.interactions.selection[app].medianPaintMs > 0);
    assert.ok(report.memory[app].beforeBytes > 0);
    assert.ok(report.memory[app].afterBytes > 0);
    assert.equal(report.memory[app].runs.length, 6);
    assert.ok(report.lighthouse[app].performanceScore >= 0);
    assert.match(markdown, new RegExp(`!\\[${app} CPU flame chart\\]`));
    assert.ok(existsSync(`benchmark/results/favorite-${app}.svg`));
  }
  const selected = (app) => report.actions[app].find((action) => action.name === "select incident");
  assert.equal(selected("manual").rowRenders, 1);
  assert.equal(selected("baseline").rowRenders, 67);
  assert.doesNotMatch(report.evaluation.recommendation, /avoids more row work/);
  for (const [app, expected] of [
    ["manual", 2],
    ["baseline", 4],
  ]) {
    assert.equal(
      report.actions[app].find((action) => action.name === "switch queue").queueRenders,
      expected,
    );
  }
  assert.ok(selected("baseline").openButtonRenders > selected("manual").openButtonRenders);
  assert.ok(
    report.actions.baseline.find((action) => action.name === "favorite incident")
      .openButtonRenders >
      report.actions.manual.find((action) => action.name === "favorite incident").openButtonRenders,
  );
  for (const app of ["compiler", "manual", "baseline"]) {
    assert.ok(
      report.actions[app].find((action) => action.name === "favorite incident")
        .favoriteButtonRenders > 0,
    );
  }
  assert.match(markdown, /Open-button render-work events/);
  assert.ok(Number.isFinite(report.baselineDeltas.compiler.total.gzip.bytes));
});

test("load-memory report preserves both CDP heap counters, phases, runs and relative differences", () => {
  const raw = JSON.parse(readFileSync("benchmark/results/load-memory.json", "utf8"));
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  assert.deepEqual(report.loadMemory, analyzeLoadMemory(raw, report.versions.playwrightChromium));
  assert.ok(markdown.includes(loadMemoryMarkdown(report.loadMemory, 3).join("\n")));
  for (const app of ["compiler", "manual", "baseline"]) {
    const value = report.loadMemory.apps[app];
    assert.equal(value.runs.length, 6);
    for (const field of ["usedSize", "embedderHeapUsedSize"]) {
      for (const phase of ["ready", "sampledPeak", "postGC"]) {
        const summary = value.phases[phase][field];
        assert.ok(Number.isFinite(summary.medianBytes) && summary.medianBytes >= 0);
        assert.ok(
          summary.minBytes <= summary.medianBytes && summary.medianBytes <= summary.maxBytes,
        );
      }
      for (const run of value.runs) assert.ok(run.sampledPeak[field] >= run.ready[field]);
    }
  }
  assert.match(markdown, /natural GC can occur/);
  assert.match(markdown, /not proof of a compiler-caused reduction/);
});

test("report evidence matches measured sources, builds and optional ablation", () => {
  const directory = "benchmark/results";
  const report = JSON.parse(readFileSync(`${directory}/comparison.json`, "utf8"));
  const markdown = readFileSync(`${directory}/comparison.md`, "utf8");
  validateProvenance(report.provenance, directory);
  const sources = ["compiler", "manual"].map((app) => {
    const path = `sources/${app}-App.js`;
    assert.equal(
      hashFiles(directory, [path])[path],
      report.provenance.builds[app].production["./sources/App.js"],
    );
    return readFileSync(`${directory}/${path}`, "utf8");
  });
  assert.deepEqual(report.rowCaching, inspectRowCaching(...sources));
  assert.ok(markdown.includes(selectionEvidence(report.actions)));
  assert.ok(markdown.includes(report.rowCaching.explanation));
  if (report.rowCaching.status === "recognized") {
    for (const { code } of report.rowCaching.excerpts) assert.ok(markdown.includes(code));
    assert.match(markdown, /not a general inability of React Compiler/);
  } else {
    assert.match(markdown, /Generated-code pattern changed/);
  }
  assert.deepEqual(report.rowMemo, loadAblationEvidence(report));
  assert.ok(markdown.includes(ablationMarkdown(report.rowMemo, 3).join("\n")));
  if (report.rowMemo.status === "available") {
    assert.match(markdown, /byte-identical/);
    assert.match(markdown, /cannot predict the benefit of adding memo to the compiler/);
    assert.match(markdown, /Spanning zero is inconclusive, not equivalence/);
    const mismatched = structuredClone(report);
    mismatched.provenance.builds.manual.production[`./${report.bundles.manual.files.js[0]}`] =
      "changed";
    assert.throws(() => loadAblationEvidence(mismatched), /bytes differ/);
    const older = structuredClone(report);
    older.provenance.sourceFingerprint = "0".repeat(64);
    const unavailable = loadAblationEvidence(older);
    assert.equal(unavailable.status, "unavailable");
    assert.doesNotMatch(ablationMarkdown(unavailable).join("\n"), /\]\(row-memo\//);
  } else {
    assert.match(markdown, /Ablation unavailable for this build/);
    assert.doesNotMatch(markdown, /\]\(row-memo\//);
  }
});

test("typed filtering report matches every raw timing and profiling step", () => {
  const raw = JSON.parse(readFileSync("benchmark/results/filtering-latency.json", "utf8"));
  const input = JSON.parse(readFileSync("benchmark/results/measurements.json", "utf8"));
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  const markdown = readFileSync("benchmark/results/comparison.md", "utf8");
  assert.deepEqual(report.interactions.filtering, analyzeFiltering(raw, input.browser));
  const section = markdown.split("## Query filtering\n")[1].split("## Additional evidence\n")[0];
  assert.match(section, /200 \/ 34 \/ 34 \/ 200/);
  assert.match(section, /no result change/);
  assert.match(section, /remounts 166/);
  assert.doesNotMatch(section, /favorite-.*cpuprofile|Load memory/);
  for (const app of ["baseline", "manual", "compiler"]) {
    for (const [index, step] of filteringProtocol.steps.entries()) {
      const samples = input.repetitions.map((repeat) => {
        const path = repeat[app].paths.filtering;
        assert.deepEqual(path.initialState, filteringProtocol.initialState);
        const action = path.actions[index];
        assert.equal(action.name, step.name);
        return countProfileRecords(action.records, action.fiberRenders);
      });
      assert.deepEqual(report.paths.filtering[app][index], {
        ...step,
        ...summarizeProfileSamples(samples),
      });
      assert.equal(report.paths.filtering[app][index].mounts.rows, index === 3 ? 166 : 0);
      assert.equal(report.interactions.filtering.apps[app][index].runs.length, 20);
    }
  }
});

test("comparison preserves schema-v2 root phases and independent actual/base summaries", () => {
  const input = JSON.parse(readFileSync("benchmark/results/measurements.json", "utf8"));
  const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
  assert.equal(input.schemaVersion, 2);
  assert.equal(report.schemaVersion, 2);
  const keys = [
    "root",
    "shell",
    "toolbar",
    "list",
    "detail",
    "rows",
    "queueItems",
    "openButtons",
    "favoriteButtons",
  ];
  for (const app of ["compiler", "manual", "baseline"]) {
    for (const repetition of input.repetitions) {
      validateProfileRecords(repetition[app].actions.flatMap((action) => action.records));
    }
    assert.equal(report.actions[app].length, input.repetitions[0][app].actions.length);
    for (const [index, action] of report.actions[app].entries()) {
      const samples = input.repetitions.map((repetition) => {
        const raw = repetition[app].actions[index];
        assert.equal(action.name, raw.name);
        return countProfileRecords(raw.records, raw.fiberRenders);
      });
      assert.deepEqual(action, { name: action.name, ...summarizeProfileSamples(samples) });
      for (const summary of [action, action.mounts]) {
        assert.deepEqual(Object.keys(summary.medianDurationMs), keys);
        assert.deepEqual(Object.keys(summary.medianBaseDurationMs), keys);
      }
      for (const run of action.runs) {
        assert.equal(
          run.commits,
          Object.values(run.rootPhaseCounts).reduce((sum, count) => sum + count, 0),
        );
        assert.equal(run.root, run.rootPhaseCounts.update + run.rootPhaseCounts["nested-update"]);
        assert.equal(run.mounts.root, run.rootPhaseCounts.mount);
      }
    }
  }
});

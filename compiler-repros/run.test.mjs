import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { suppressionFinding, suppressionOptOut } from "./findings.mjs";
import { publicEvidence, renderHtml, writePublicArtifacts } from "./html.mjs";
import {
  cases,
  compileBabel,
  compileOxc,
  compileSwc,
  fixturePath,
  inspectCode,
  matchAnalyzer,
  parseAnalyzerOutput,
  runComparison,
  summarize,
  versionWarnings,
} from "./run.mjs";

test("cache inspection follows imported bindings and isolates nested functions", () => {
  const records = inspectCode(`
    import { c as cache } from "react/compiler-runtime";
    function Example() {
      const slots = cache(3);
      function Child() { return cache(2); }
      return Child;
    }
    function Shadowed(cache) { return cache(9); }
  `);
  assert.deepEqual(
    records.map(({ name, slots }) => [name, slots]),
    [
      ["Example", [3]],
      ["Child", [2]],
      ["Shadowed", []],
    ],
  );
});

test("unrelated c calls and runtime imports without calls are not cache evidence", () => {
  assert.deepEqual(inspectCode("function Example(c) { return c(8); }")[0].slots, []);
  assert.deepEqual(
    inspectCode('import { c } from "react/compiler-runtime"; function Example() {}')[0].slots,
    [],
  );
});

test("an acceptance event does not prove an emitted cache", () => {
  const result = {
    fatal: false,
    events: [{ kind: "CompileSuccess", name: "Example" }],
    functions: [{ name: "Example", slots: [] }],
  };
  assert.equal(summarize(result, "Example").reportedStatus, "compiled");
  assert.equal(summarize(result, "Example").cacheEmitted, false);
  assert.equal(summarize({ ...result, events: null }, "Example").reportedStatus, "unavailable");
});

test("positive and opt-out guards inspect real output from all three compilers", () => {
  for (const compiler of [compileBabel, compileOxc, compileSwc]) {
    for (const [id, expected] of [
      ["smoke", true],
      ["module-opt-out", false],
    ]) {
      const filename = fixturePath(id);
      const result = compiler(readFileSync(filename, "utf8"), filename);
      assert.equal(result.fatal, false, `${compiler.name}: ${id}`);
      assert.equal(summarize(result, "Example").cacheEmitted, expected, `${compiler.name}: ${id}`);
    }
  }
});

test("suppression labels require a reported reason rather than source text or missing caches", () => {
  const event = { name: "Example", detail: { category: "Suppression" } };
  assert.equal(suppressionOptOut({ fatal: false, diagnostics: [event] }, "Example"), true);
  assert.equal(suppressionOptOut({ fatal: false, diagnostics: [event] }, "Other"), false);
  assert.equal(suppressionOptOut({ fatal: true, diagnostics: [event] }, "Example"), false);
  assert.equal(
    suppressionOptOut(
      { fatal: false, diagnostics: [{ message: "React rule suppression prevents optimization" }] },
      "Example",
    ),
    true,
  );
  assert.equal(
    suppressionOptOut(
      {
        fatal: false,
        diagnostics: [
          {
            message: "Conditional hook",
            codeframe: "// eslint-disable-next-line react-hooks/rules-of-hooks",
          },
        ],
      },
      "Example",
    ),
    false,
  );
  assert.equal(suppressionOptOut({ fatal: false, diagnostics: [] }, "Example"), false);
});

test("Babel analysis-only mode records events without attributing emitted code", () => {
  const filename = fixturePath("smoke");
  const result = compileBabel(readFileSync(filename, "utf8"), filename, { noEmit: true });
  assert.ok(result.events.some((event) => event.kind === "CompileSuccess"));
  assert.equal(summarize(result, "Example").cacheEmitted, false);
});

test("SWC preserves unavailable success telemetry and captures fatal parse errors", () => {
  const filename = fixturePath("smoke");
  const result = compileSwc(readFileSync(filename, "utf8"), filename);
  assert.equal(result.events, null);
  assert.equal(summarize(result, "Example").reportedStatus, "unavailable");
  assert.deepEqual(result.options.jsc.transform.reactCompiler, {
    compilationMode: "infer",
    target: "19",
    panicThreshold: "none",
  });
  assert.equal(result.options.swcrc, false);
  assert.equal(result.options.configFile, false);
  const invalid = compileSwc("export function Example( {", filename);
  assert.equal(invalid.fatal, true);
  assert.equal(invalid.code, "");
  assert.ok(invalid.exception.message.length);
});

test("pragma and computed-key pairs change only the investigated expression", () => {
  const source = (id) => readFileSync(fixturePath(id), "utf8");
  assert.equal(
    source("valid-hooks-redundant-suppression").replace(
      "  // eslint-disable-next-line react-hooks/exhaustive-deps\n",
      "",
    ),
    source("valid-hooks-no-suppression"),
  );
  for (const [repro, control] of [
    ["computed-template-key", "computed-member-key-control"],
    ["computed-template-key-mutation", "computed-member-key-mutation-control"],
  ]) {
    assert.equal(
      source(repro)
        .replaceAll("[`${styleKeys.color}`]", "[styleKeys.color]")
        .replaceAll("[`${styleKeys.fill}`]", "[styleKeys.fill]"),
      source(control),
    );
  }
});

test("invalid hook variants differ only by the rules-of-hooks suppression", () => {
  const control = readFileSync(fixturePath("invalid-hooks-no-suppression"), "utf8");
  const suppressed = readFileSync(fixturePath("invalid-hooks-with-suppression"), "utf8");
  assert.equal(
    suppressed.replace("    // eslint-disable-next-line react-hooks/rules-of-hooks\n", ""),
    control,
  );
  assert.ok(control.includes("if (enabled) {\n    useEffect("));
  assert.ok(control.includes("}, [label]);"));
});

test("all fixtures parse and all three compiler adapters return structured observations", () => {
  assert.equal(cases.length, 14);
  for (const fixture of cases) {
    const filename = fixturePath(fixture.id);
    const source = readFileSync(filename, "utf8");
    for (const compiler of [compileBabel, compileOxc, compileSwc]) {
      const result = compiler(source, filename);
      assert.equal(typeof result.code, "string");
      assert.equal(typeof result.fatal, "boolean");
      assert.ok(Array.isArray(result.diagnostics));
      assert.doesNotThrow(() => JSON.stringify(result));
    }
  }
});

test("RCA joins use file and source location, not just repeated function names", () => {
  const source = "function Example() { function Example() {} }";
  const functions = inspectCode(source);
  const records = [
    ...functions.map((record) => ({
      file: fixturePath("smoke"),
      function: record.name,
      line: record.line,
      column: record.column,
    })),
    { file: fixturePath("module-opt-out"), function: "Example", line: 1, column: 0 },
  ];
  assert.deepEqual(matchAnalyzer(records, fixturePath("smoke"), source, functions[0]), [
    records[0],
  ]);
  assert.deepEqual(matchAnalyzer(records, fixturePath("smoke"), source, functions[1]), [
    records[1],
  ]);
});

test("RCA failures preserve valid JSON and stderr without treating nonzero exit as parity", () => {
  const document = {
    schemaVersion: 2,
    tool: "react-compiler-analyzer",
    command: "analyze",
    mode: "infer",
    summary: {},
    functions: [],
    unparseable: [],
  };
  const result = parseAnalyzerOutput({
    status: 3,
    stdout: JSON.stringify(document),
    stderr: "warning",
  });
  assert.deepEqual(result.document, document);
  assert.equal(result.stderr, "warning");
  assert.equal(result.toolFailure, true);
  assert.equal(result.parseError, null);
  for (const stdout of [
    "",
    "not json",
    "{}",
    '{"functions":[]}',
    JSON.stringify({ ...document, functions: [{}] }),
  ]) {
    assert.equal(parseAnalyzerOutput({ status: 0, stdout, stderr: "" }).toolFailure, true);
  }
});

test("provenance flags requested and analyzer-resolved compiler version mismatches", () => {
  const packageInfo = {
    version: "1.0.0",
    requested: "1.0.0",
    resolvedPath: "/compiler/package.json",
  };
  const provenance = {
    packages: { "babel-plugin-react-compiler": packageInfo },
    analyzerCompiler: { "babel-plugin-react-compiler": { ...packageInfo } },
  };
  assert.deepEqual(versionWarnings(provenance), []);
  provenance.packages["babel-plugin-react-compiler"] = { ...packageInfo, requested: "2.0.0" };
  provenance.analyzerCompiler["babel-plugin-react-compiler"].version = "0.9.0";
  assert.equal(versionWarnings(provenance).length, 2);
});

test("public evidence removes workspace and executable paths recursively", () => {
  const evidence = publicEvidence({
    path: `${process.cwd()}/node_modules/example/index.js`,
    command: [process.execPath, `${process.cwd()}/compiler-repros/run.mjs`],
    diagnostic: { codeframe: `at ${process.cwd()}/compiler-repros/cases/smoke.tsx:1:1` },
  });
  assert.equal(evidence.path, "node_modules/example/index.js");
  assert.equal(evidence.command[0], "node");
  assert.equal(JSON.stringify(evidence).includes(process.cwd()), false);
  assert.equal(JSON.stringify(evidence).includes(process.execPath), false);
});

test("full comparison includes every fixture, raw artifacts, and analysis-only RCA triangulation", (context) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "compiler-repros-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const report = runComparison({ outputDirectory });
  assert.deepEqual(report.failures, []);
  assert.equal(report.cases.length, cases.length);
  assert.equal(report.analyzer.document.summary.unparseableFiles, 0);
  assert.equal(report.provenance.packages["@swc/core"].version, "1.16.20");
  for (const fixture of report.cases) {
    assert.match(fixture.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(fixture.babelVsAnalyzer.disagreement, false, fixture.id);
    for (const suffix of [
      "source.tsx",
      "babel.tsx",
      "babel.json",
      "babel-analysis.json",
      "oxc.jsx",
      "oxc.json",
      "swc.jsx",
      "swc.json",
      "babel-swc.diff",
      "oxc-swc.diff",
      "diff",
    ]) {
      assert.ok(existsSync(join(outputDirectory, `${fixture.id}.${suffix}`)));
    }
    assert.equal(typeof fixture.summary.swc.cacheEmitted, "boolean");
    assert.equal(fixture.summary.swc.reportedStatus, "unavailable");
    assert.deepEqual(Object.keys(fixture.comparisons), ["babel-oxc", "babel-swc", "oxc-swc"]);
    for (const pair of Object.keys(fixture.comparisons)) {
      assert.equal(typeof fixture.comparisons[pair].cacheMismatch, "boolean");
      assert.equal(typeof fixture.comparisons[pair].diagnosticPresenceMismatch, "boolean");
      assert.equal(typeof fixture.codegenDiffs[pair], "string");
    }
  }
  const optOut = report.cases.find((fixture) => fixture.id === "module-opt-out");
  assert.equal(optOut.summary.babel.cacheEmitted, false);
  assert.equal(optOut.summary.swc.cacheEmitted, false);
  assert.equal(optOut.summary.analyzer.reportedStatus, "compiled");
  assert.equal(optOut.summary.analyzer.cacheEmitted, null);
  const suppressed = report.cases.find(
    (fixture) => fixture.id === "valid-hooks-redundant-suppression",
  );
  assert.equal(suppressed.summary.babel.reason, "suppression-opt-out");
  assert.equal(suppressed.summary.oxc.reason, "suppression-opt-out");
  assert.equal(suppressed.summary.swc.reason, null);
  assert.equal(suppressed.summary.babel.reportedStatus, "error");
  assert.equal(suppressed.babel.diagnostics[0].kind, "CompileError");
  assert.equal(suppressed.babel.diagnostics[0].detail.category, "Suppression");
  assert.equal(
    suppressed.oxc.diagnostics[0].message,
    "React rule suppression prevents optimization",
  );
  assert.ok(suppressionFinding(report));
  assert.ok(
    readFileSync(join(outputDirectory, "comparison.md"), "utf8").includes("## Key Finding"),
  );
  assert.ok(
    readFileSync(join(outputDirectory, "comparison.md"), "utf8").includes("Suppression opt-out"),
  );
  for (const mutate of [
    (changed) => changed.failures.push("Incomplete run"),
    (changed) => {
      changed.cases = changed.cases.filter(
        (fixture) => fixture.id !== "invalid-hooks-no-suppression",
      );
    },
    (changed) => {
      changed.cases.find(
        (fixture) => fixture.id === "valid-hooks-redundant-suppression",
      ).summary.swc.cacheEmitted = false;
    },
    (changed) => {
      changed.cases.find(
        (fixture) => fixture.id === "valid-hooks-redundant-suppression",
      ).summary.oxc.reason = null;
    },
    (changed) => {
      changed.cases.find(
        (fixture) => fixture.id === "invalid-hooks-with-suppression",
      ).summary.swc.cacheEmitted = true;
    },
    (changed) => {
      changed.cases.find(
        (fixture) => fixture.id === "valid-hooks-no-suppression",
      ).summary.babel.cacheEmitted = false;
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(suppressionFinding(changed), null);
    assert.equal(renderHtml(changed).includes('id="key-finding"'), false);
  }
  assert.ok(readFileSync(join(outputDirectory, "comparison.md"), "utf8").includes("not runtime"));
  assert.equal(
    JSON.parse(readFileSync(join(outputDirectory, "comparison.json"), "utf8")).cases.length,
    cases.length,
  );
  assert.ok(
    readFileSync(join(outputDirectory, "comparison.md"), "utf8").includes("react-compiler("),
  );
  const html = readFileSync(join(outputDirectory, "index.html"), "utf8");
  assert.ok(html.includes("Compiler compatibility"));
  assert.ok(html.includes('<th scope="col">SWC cache</th>'));
  assert.ok(html.includes("<strong>SWC</strong> 1.16.20"));
  assert.equal(html.includes(process.cwd()), false);
  for (const fixture of report.cases) {
    assert.ok(html.includes(`data-case="${fixture.id}"`));
    assert.equal(typeof fixture.source, "string");
  }
  const hostile = structuredClone(report);
  hostile.cases[0].babel.code = "</script><script>globalThis.injected = true</script>";
  assert.equal(renderHtml(hostile).includes("</script><script>globalThis.injected"), false);
  assert.ok(renderHtml(hostile).includes("\\u003c/script>"));
  const swcOnly = structuredClone(report);
  for (const fixture of swcOnly.cases) {
    for (const comparison of Object.values(fixture.comparisons)) {
      comparison.cacheMismatch = false;
      comparison.slotsMismatch = false;
      comparison.diagnosticPresenceMismatch = false;
    }
  }
  swcOnly.cases[0].comparisons["oxc-swc"].cacheMismatch = true;
  assert.ok(renderHtml(swcOnly).includes('id="cache-differences">1</strong>'));
  writePublicArtifacts(report, outputDirectory);
  for (const name of readdirSync(outputDirectory)) {
    const artifact = readFileSync(join(outputDirectory, name), "utf8");
    assert.equal(artifact.includes(process.cwd()), false, `Public path leak in ${name}`);
    assert.equal(artifact.includes(process.execPath), false, `Executable path leak in ${name}`);
  }
  assert.deepEqual(runComparison({ outputDirectory }), report);
});

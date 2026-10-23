import { transformSync as babelTransform } from "@babel/core";
import { transformSync as swcTransform } from "@swc/core";
import { createTwoFilesPatch } from "diff";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync as oxcTransform } from "oxc-transform-react";
import ts from "typescript";
import { suppressionFinding, suppressionOptOut } from "./findings.mjs";
import { renderHtml } from "./html.mjs";

const require = createRequire(import.meta.url);
export const directory = dirname(fileURLToPath(import.meta.url));
const root = dirname(directory);
export const compilerOptions = { compilationMode: "infer", target: "19", panicThreshold: "none" };

export const cases = [
  { id: "smoke", group: "guard", target: "Example" },
  { id: "module-opt-out", group: "guard", target: "Example", control: "smoke" },
  { id: "valid-hooks-no-suppression", group: "suppression-valid-hooks", target: "Example" },
  {
    id: "valid-hooks-redundant-suppression",
    group: "suppression-valid-hooks",
    target: "Example",
    control: "valid-hooks-no-suppression",
  },
  { id: "invalid-hooks-no-suppression", group: "suppression-invalid-hooks", target: "Example" },
  {
    id: "invalid-hooks-with-suppression",
    group: "suppression-invalid-hooks",
    target: "Example",
    control: "invalid-hooks-no-suppression",
  },
  { id: "module-component-control", group: "nested-component", target: "Example" },
  {
    id: "inline-component",
    group: "nested-component",
    target: "Example",
    control: "module-component-control",
  },
  { id: "hoisting-before-return-control", group: "hoisting", target: "Example" },
  {
    id: "hoisting-after-return",
    group: "hoisting",
    target: "Example",
    control: "hoisting-before-return-control",
  },
  {
    id: "computed-member-key-mutation-control",
    group: "computed-keys-mutation",
    target: "useWidgetStyle",
  },
  {
    id: "computed-template-key-mutation",
    group: "computed-keys-mutation",
    target: "useWidgetStyle",
    control: "computed-member-key-mutation-control",
  },
  { id: "computed-member-key-control", group: "computed-keys", target: "Example" },
  {
    id: "computed-template-key",
    group: "computed-keys",
    target: "Example",
    control: "computed-member-key-control",
  },
];

export function fixturePath(id) {
  if (!cases.some((fixture) => fixture.id === id)) throw new Error(`Unknown fixture: ${id}`);
  return join(directory, "cases", `${id}.tsx`);
}

export function inspectCode(code) {
  const filename = "output.tsx";
  const source = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const options = { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => (path === filename ? source : undefined);
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const cacheBindings = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.text !== "react/compiler-runtime"
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      if ((specifier.propertyName ?? specifier.name).text === "c") {
        cacheBindings.add(checker.getSymbolAtLocation(specifier.name));
      }
    }
  }
  const functions = [];
  function visit(node, owner = null) {
    if (ts.isFunctionLike(node) && node.body) {
      const nameNode =
        node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : null);
      const start = node.getStart(source);
      const position = source.getLineAndCharacterOfPosition(start);
      owner = {
        name: nameNode && ts.isIdentifier(nameNode) ? nameNode.text : null,
        start,
        end: node.end,
        line: position.line + 1,
        column: position.character,
        slots: [],
      };
      functions.push(owner);
    }
    if (owner && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol && cacheBindings.has(symbol)) {
        const argument = node.arguments[0];
        owner.slots.push(argument && ts.isNumericLiteral(argument) ? Number(argument.text) : null);
      }
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  }
  visit(source);
  return functions;
}

function eventName(event, source, functions) {
  if (event.fnName) return event.fnName;
  const position = event.fnLoc?.start;
  if (!position) return null;
  const offset = source.getPositionOfLineAndCharacter(position.line - 1, position.column);
  return (
    functions
      .filter((record) => record.start <= offset && offset < record.end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0]?.name ?? null
  );
}

function diagnosticDetail(detail, source) {
  if (typeof detail === "string") return { message: detail };
  if (!detail) return null;
  const options = detail.options ?? detail;
  let message = options.reason ?? detail.message ?? String(detail);
  if (typeof detail.printErrorMessage === "function") {
    message = detail.printErrorMessage(source, { eslint: false });
  }
  return {
    category: options.category ?? null,
    reason: options.reason ?? null,
    description: options.description ?? null,
    loc: options.loc ?? null,
    message,
  };
}

export function compileBabel(source, filename, { noEmit = false } = {}) {
  const events = [];
  const sourceAst = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sourceFunctions = inspectCode(source);
  const options = { ...compilerOptions, noEmit };
  let code = "";
  let exception = null;
  try {
    code =
      babelTransform(source, {
        filename,
        babelrc: false,
        configFile: false,
        sourceType: "module",
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [
          [
            require.resolve("babel-plugin-react-compiler"),
            {
              ...options,
              logger: {
                logEvent: (_filename, event) =>
                  events.push({
                    ...event,
                    name: eventName(event, sourceAst, sourceFunctions),
                    detail: diagnosticDetail(event.detail, source),
                  }),
              },
            },
          ],
        ],
      }).code ?? "";
  } catch (error) {
    exception = { name: error.name, message: error.message, loc: error.loc ?? null };
  }
  return {
    fatal: exception !== null,
    options,
    code,
    functions: inspectCode(code),
    events,
    diagnostics: events.filter((event) =>
      ["CompileError", "PipelineError", "CompileSkip"].includes(event.kind),
    ),
    exception,
  };
}

export function compileOxc(source, filename) {
  const options = {
    lang: "tsx",
    sourceType: "module",
    jsx: "preserve",
    reactCompiler: { ...compilerOptions },
  };
  try {
    const result = oxcTransform(filename, source, options);
    return {
      fatal: result.fatal,
      options,
      code: result.code,
      functions: inspectCode(result.code),
      events: null,
      diagnostics: result.errors,
      exception: null,
    };
  } catch (error) {
    return {
      fatal: true,
      options,
      code: "",
      functions: [],
      events: null,
      diagnostics: [],
      exception: { name: error.name, message: error.message },
    };
  }
}

export function compileSwc(source, filename) {
  const options = {
    filename,
    swcrc: false,
    configFile: false,
    jsc: {
      target: "esnext",
      parser: { syntax: "typescript", tsx: true },
      transform: {
        react: { runtime: "preserve" },
        reactCompiler: { ...compilerOptions },
      },
    },
  };
  try {
    const result = swcTransform(source, options);
    return {
      fatal: false,
      options,
      code: result.code,
      functions: inspectCode(result.code),
      events: null,
      diagnostics: (result.diagnostics ?? []).map((message) => ({ message })),
      exception: null,
    };
  } catch (error) {
    return {
      fatal: true,
      options,
      code: "",
      functions: [],
      events: null,
      diagnostics: [],
      exception: { name: error.name, message: error.message },
    };
  }
}

export function summarize(result, target) {
  const functions = result.functions.filter((record) => record.name === target);
  const events = result.events?.filter((event) => event.name === target) ?? [];
  const kinds = events.map((event) => event.kind);
  const reportedStatus = result.fatal
    ? "fatal"
    : result.events === null
      ? "unavailable"
      : kinds.some((kind) => ["CompileError", "PipelineError"].includes(kind))
        ? "error"
        : kinds.includes("CompileSkip")
          ? "skipped"
          : kinds.includes("CompileSuccess")
            ? "compiled"
            : "not-discovered";
  return {
    reportedStatus,
    reason: suppressionOptOut(result, target) ? "suppression-opt-out" : null,
    cacheEmitted: result.fatal || functions.length !== 1 ? null : functions[0].slots.length > 0,
    slots: functions.length === 1 ? functions[0].slots : null,
  };
}

export function matchAnalyzer(records, filename, source, sourceFunction) {
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = inspectCode(source);
  return records.filter((record) => {
    if (resolve(root, record.file) !== resolve(filename) || record.function !== sourceFunction.name)
      return false;
    const offset = ast.getPositionOfLineAndCharacter(record.line - 1, record.column);
    const owner = functions
      .filter((item) => item.start <= offset && offset < item.end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    return owner?.start === sourceFunction.start && owner?.end === sourceFunction.end;
  });
}

export function parseAnalyzerOutput(result) {
  let document = null;
  let parseError = null;
  try {
    document = JSON.parse(result.stdout ?? "");
    if (
      document?.schemaVersion !== 2 ||
      document.tool !== "react-compiler-analyzer" ||
      document.command !== "analyze" ||
      document.mode !== "infer" ||
      !document.summary ||
      !Array.isArray(document.functions) ||
      !Array.isArray(document.unparseable) ||
      !document.functions.every(
        (record) =>
          typeof record.file === "string" &&
          Number.isInteger(record.line) &&
          record.line >= 1 &&
          Number.isInteger(record.column) &&
          record.column >= 0 &&
          ["compiled", "skipped", "error"].includes(record.status),
      )
    ) {
      throw new Error("Unexpected RCA JSON schema; expected analyze schemaVersion 2 in infer mode");
    }
  } catch (error) {
    parseError = error.message;
  }
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    executionError: result.error?.message ?? null,
    document,
    parseError,
    toolFailure:
      result.status !== 0 ||
      Boolean(result.error) ||
      parseError !== null ||
      (document?.unparseable?.length ?? 0) > 0,
  };
}

function packageInfo(name, resolver = require) {
  const resolvedPath = resolver.resolve(`${name}/package.json`);
  const manifest = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return { version: manifest.version, resolvedPath };
}

export function versionWarnings(provenance) {
  const warnings = [];
  for (const [name, info] of Object.entries(provenance.packages)) {
    if (info.requested && /^\d/.test(info.requested) && info.requested !== info.version) {
      warnings.push(`${name}: requested ${info.requested}, installed ${info.version}`);
    }
  }
  for (const [name, info] of Object.entries(provenance.analyzerCompiler)) {
    const direct = provenance.packages[name];
    if (direct && (info.version !== direct.version || info.resolvedPath !== direct.resolvedPath)) {
      warnings.push(
        `RCA resolves ${name} ${info.version} at ${info.resolvedPath}; direct transform resolves ${direct.version} at ${direct.resolvedPath}`,
      );
    }
  }
  return warnings;
}

function provenance() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = [
    "@babel/core",
    "@swc/core",
    "babel-plugin-react-compiler",
    "oxc-transform-react",
    "@fluentui/react-compiler-analyzer",
    "typescript",
  ];
  const packages = Object.fromEntries(
    names.map((name) => [
      name,
      {
        ...packageInfo(name),
        requested: manifest.devDependencies[name] ?? null,
      },
    ]),
  );
  const analyzerRequire = createRequire(packages["@fluentui/react-compiler-analyzer"].resolvedPath);
  const result = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    packages,
    analyzerCompiler: Object.fromEntries(
      ["@babel/core", "babel-plugin-react-compiler"].map((name) => [
        name,
        packageInfo(name, analyzerRequire),
      ]),
    ),
    compilerOptions,
    suppressionRules:
      "Not overridden; each compiler's defaults. Suppression behavior is measured by the paired fixture.",
    analyzerOptions: {
      compilationMode: "infer",
      noEmit: true,
      panicThreshold: "none",
      target: "19 (Babel default)",
    },
    analyzerConfig: JSON.parse(readFileSync(join(directory, "rca.config.json"), "utf8")),
  };
  return { ...result, warnings: versionWarnings(result) };
}

function runAnalyzer() {
  const info = packageInfo("@fluentui/react-compiler-analyzer");
  const manifest = JSON.parse(readFileSync(info.resolvedPath, "utf8"));
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin["react-compiler-analyzer"];
  const args = [
    resolve(dirname(info.resolvedPath), bin),
    "--config",
    join(directory, "rca.config.json"),
    "analyze",
    join(directory, "cases"),
    "--mode",
    "infer",
    "--format",
    "json",
    "--strict-paths",
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return { invocation: [process.execPath, ...args], cwd: root, ...parseAnalyzerOutput(result) };
}

function cacheText(summary) {
  if (summary.cacheEmitted === null) return "unknown";
  return summary.cacheEmitted ? `yes (${summary.slots.join(", ")} slots)` : "no";
}

function compareOutputs(left, right, target) {
  const before = summarize(left, target);
  const after = summarize(right, target);
  return {
    cacheMismatch: before.cacheEmitted !== after.cacheEmitted,
    slotsMismatch:
      before.cacheEmitted === true &&
      after.cacheEmitted === true &&
      JSON.stringify(before.slots) !== JSON.stringify(after.slots),
    diagnosticPresenceMismatch: left.diagnostics.length > 0 !== right.diagnostics.length > 0,
    codegenDiffers: left.code !== right.code,
  };
}

function markdown(report) {
  const finding = suppressionFinding(report);
  const lines = [
    "# Babel / OXC / SWC React Compiler Repros",
    "",
    "This is a compile-time comparison, not runtime correctness or performance evidence.",
    "All three direct transforms receive identical source and filename, infer mode, React 19 target, and default suppression handling.",
    "Babel preserves TypeScript; OXC and SWC strip it. Codegen diffs are inspection artifacts, not semantic-equivalence tests.",
    "RCA uses noEmit: true. Its acceptance and memo-slot statistics are not proof of an emitted memo cache.",
    "OXC and SWC have no per-function success logger in these APIs; inspect emitted cache and diagnostic evidence separately. SWC can omit diagnostics for unoptimized functions, so diagnostic telemetry differences do not prove an acceptance difference.",
    "",
    "## Versions",
    "",
    `Node ${report.provenance.node}, ${report.provenance.platform}.`,
    "",
    ...Object.entries(report.provenance.packages).map(
      ([name, info]) => `- ${name}: ${info.version} (requested ${info.requested ?? "transitive"})`,
    ),
    ...report.provenance.warnings.map((warning) => `- WARNING: ${warning}`),
    "",
    ...(finding
      ? [
          "## Key Finding",
          "",
          `### ${finding.title}`,
          "",
          finding.summary,
          "",
          finding.validation,
          "",
          finding.caveat,
          "",
          ...finding.evidence.map((evidence) => `- [${evidence.label}](${evidence.id}.source.tsx)`),
          "",
        ]
      : []),
    "## Target Functions",
    "",
    "| Fixture | Babel event | Babel cache | OXC cache | SWC cache | OXC diagnostics | SWC diagnostics | RCA event | RCA/Babel analysis mismatch |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (fixture) =>
        `| ${fixture.id} | ${fixture.summary.babel.reportedStatus}${fixture.summary.babel.reason === "suppression-opt-out" ? " (Suppression opt-out)" : ""} | ${cacheText(fixture.summary.babel)} | ${cacheText(fixture.summary.oxc)} | ${cacheText(fixture.summary.swc)} | ${fixture.oxc.diagnostics.length}${fixture.summary.oxc.reason === "suppression-opt-out" ? " (Suppression opt-out)" : ""} | ${fixture.swc.diagnostics.length} | ${fixture.summary.analyzer.reportedStatus} | ${fixture.babelVsAnalyzer.disagreement ? "yes" : "no"} |`,
    ),
    "",
    "A missing cache without an explicit diagnostic is not automatically a bailout. not-discovered means no matching Babel/RCA event was observed.",
    "The mutation-preserving hooks may not be discovered under infer. Their mutation-free component pair independently tests computed-key lowering.",
    "Defining a component during render is not recommended; acceptance does not establish stable component identity.",
    "",
    "## Evidence",
    "",
  ];
  for (const fixture of report.cases) {
    lines.push(
      `### ${fixture.id}`,
      "",
      `Target: ${fixture.target}. Control: ${fixture.control ?? "none"}. SHA-256: ${fixture.sourceHash}.`,
      "",
      `[Input](${fixture.id}.source.tsx) | [Babel](${fixture.id}.babel.tsx) | [OXC](${fixture.id}.oxc.jsx) | [SWC](${fixture.id}.swc.jsx) | [Babel/OXC diff](${fixture.id}.diff) | [Babel/SWC diff](${fixture.id}.babel-swc.diff) | [OXC/SWC diff](${fixture.id}.oxc-swc.diff)`,
      "",
      ...Object.entries(fixture.comparisons).map(
        ([pair, comparison]) =>
          `- ${pair}: cache difference ${comparison.cacheMismatch}, slot difference ${comparison.slotsMismatch}, diagnostic telemetry difference ${comparison.diagnosticPresenceMismatch}.`,
      ),
      "",
    );
    for (const [name, result] of [
      ["Babel", fixture.babel],
      ["OXC", fixture.oxc],
      ["SWC", fixture.swc],
    ]) {
      const diagnostics = result.diagnostics.map(
        (item) =>
          item.codeframe ??
          item.detail?.message ??
          item.reason ??
          item.message ??
          JSON.stringify(item),
      );
      if (result.exception) diagnostics.push(result.exception.message);
      lines.push(
        `${name} diagnostics:`,
        "",
        "```text",
        diagnostics.join("\n\n") || "No diagnostics reported.",
        "```",
        "",
      );
    }
  }
  lines.push(
    "## Tool Failures",
    "",
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure}`) : ["None."]),
    "",
  );
  return lines.join("\n");
}

export function runComparison({ outputDirectory = join(directory, "results") } = {}) {
  mkdirSync(outputDirectory, { recursive: true });
  const analyzer = runAnalyzer();
  const analyzerRecords =
    !analyzer.parseError && Array.isArray(analyzer.document?.functions)
      ? analyzer.document.functions
      : [];
  const failures = analyzer.toolFailure
    ? [
        `RCA failed: ${analyzer.executionError ?? analyzer.parseError ?? `exit ${analyzer.exitCode}, unparseable files ${analyzer.document?.unparseable?.length ?? 0}`}`,
      ]
    : [];
  const observations = cases.map((fixture) => {
    const filename = fixturePath(fixture.id);
    const source = readFileSync(filename, "utf8");
    const babel = compileBabel(source, filename);
    const babelAnalysis = compileBabel(source, filename, { noEmit: true });
    const oxc = compileOxc(source, filename);
    const swc = compileSwc(source, filename);
    const sourceFunctions = inspectCode(source);
    const targetFunctions = sourceFunctions.filter((record) => record.name === fixture.target);
    if (targetFunctions.length !== 1)
      failures.push(`${fixture.id}: expected exactly one source target ${fixture.target}`);
    const analyzerMatches = targetFunctions.flatMap((record) =>
      matchAnalyzer(analyzerRecords, filename, source, record),
    );
    const analyzerSummary = {
      reportedStatus: analyzer.parseError
        ? "unavailable"
        : analyzerMatches.length === 1
          ? analyzerMatches[0].status
          : analyzerMatches.length > 1
            ? "ambiguous"
            : "not-discovered",
      cacheEmitted: null,
      reportedMemoSlots:
        analyzerMatches.length === 1 ? (analyzerMatches[0].memoStats?.memoSlots ?? null) : null,
    };
    const summary = {
      babel: summarize(babel, fixture.target),
      babelAnalysis: summarize(babelAnalysis, fixture.target),
      oxc: summarize(oxc, fixture.target),
      swc: summarize(swc, fixture.target),
      analyzer: analyzerSummary,
    };
    const acceptedEvent = babelAnalysis.events.find(
      (event) => event.name === fixture.target && event.kind === "CompileSuccess",
    );
    const babelVsAnalyzer = {
      disagreement:
        summary.babelAnalysis.reportedStatus !== analyzerSummary.reportedStatus ||
        (acceptedEvent?.memoSlots ?? null) !== analyzerSummary.reportedMemoSlots,
      analysisMemoSlots: acceptedEvent?.memoSlots ?? null,
      analyzerMemoSlots: analyzerSummary.reportedMemoSlots,
    };
    const outputs = { babel, oxc, swc };
    const pairs = [
      ["babel", "oxc"],
      ["babel", "swc"],
      ["oxc", "swc"],
    ];
    const comparisons = Object.fromEntries(
      pairs.map(([left, right]) => [
        `${left}-${right}`,
        compareOutputs(outputs[left], outputs[right], fixture.target),
      ]),
    );
    const codegenDiffs = Object.fromEntries(
      pairs.map(([left, right]) => [
        `${left}-${right}`,
        createTwoFilesPatch(
          `${fixture.id}.${left}.${left === "babel" ? "tsx" : "jsx"}`,
          `${fixture.id}.${right}.jsx`,
          outputs[left].code,
          outputs[right].code,
        ),
      ]),
    );
    for (const [name, result] of [
      ["Babel", babel],
      ["Babel analysis", babelAnalysis],
      ["OXC", oxc],
      ["SWC", swc],
    ]) {
      if (result.fatal)
        failures.push(
          `${fixture.id}: ${name} fatal transform: ${result.exception?.message ?? JSON.stringify(result.diagnostics)}`,
        );
    }
    const artifacts = {
      "source.tsx": source,
      "babel.tsx": babel.code,
      "babel.json": JSON.stringify(babel, null, 2),
      "babel-analysis.json": JSON.stringify(babelAnalysis, null, 2),
      "oxc.jsx": oxc.code,
      "oxc.json": JSON.stringify(oxc, null, 2),
      "swc.jsx": swc.code,
      "swc.json": JSON.stringify(swc, null, 2),
      diff: codegenDiffs["babel-oxc"],
      "babel-swc.diff": codegenDiffs["babel-swc"],
      "oxc-swc.diff": codegenDiffs["oxc-swc"],
    };
    for (const [suffix, content] of Object.entries(artifacts))
      writeFileSync(join(outputDirectory, `${fixture.id}.${suffix}`), content);
    return {
      ...fixture,
      file: relative(root, filename).split("\\").join("/"),
      source,
      codegenDiff: artifacts.diff,
      codegenDiffs,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      sourceFunctions,
      summary,
      babelVsOxc: comparisons["babel-oxc"],
      comparisons,
      babelVsAnalyzer,
      babel,
      babelAnalysis,
      oxc,
      swc,
      analyzerFunctions: analyzerRecords.filter(
        (record) => resolve(root, record.file) === filename,
      ),
      analyzerMatches,
    };
  });
  for (const [id, expected] of [
    ["smoke", true],
    ["module-opt-out", false],
  ]) {
    const fixture = observations.find((record) => record.id === id);
    for (const name of ["babel", "oxc", "swc"]) {
      if (fixture.summary[name].cacheEmitted !== expected)
        failures.push(`${id}: ${name} cache guard failed (expected ${expected})`);
    }
  }
  const report = {
    schemaVersion: 1,
    provenance: provenance(),
    failures,
    analyzer,
    cases: observations,
  };
  writeFileSync(join(outputDirectory, "analyzer.json"), analyzer.stdout);
  writeFileSync(join(outputDirectory, "analyzer.stderr.txt"), analyzer.stderr);
  writeFileSync(join(outputDirectory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "comparison.md"), markdown(report));
  writeFileSync(join(outputDirectory, "index.html"), renderHtml(report));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("Usage: node compiler-repros/run.mjs");
  const report = runComparison();
  for (const fixture of report.cases) {
    console.log(
      `${fixture.id}: Babel ${fixture.summary.babel.reportedStatus}, cache ${cacheText(fixture.summary.babel)}; OXC cache ${cacheText(fixture.summary.oxc)}, ${fixture.oxc.diagnostics.length} diagnostics; SWC cache ${cacheText(fixture.summary.swc)}, ${fixture.swc.diagnostics.length} diagnostics; RCA ${fixture.summary.analyzer.reportedStatus}`,
    );
  }
  for (const warning of report.provenance.warnings) console.warn(warning);
  for (const failure of report.failures) console.error(failure);
  console.log(`Report: ${join(directory, "results", "comparison.md")}`);
  process.exitCode = report.failures.length ? 1 : 0;
}

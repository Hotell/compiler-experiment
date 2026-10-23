import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const comparisonPackages = Object.freeze([
  "@babel/core",
  "babel-plugin-react-compiler",
  "oxc-transform-react",
  "@swc/core",
  "@fluentui/react-compiler-analyzer",
  "oxfmt",
]);

function validate(report) {
  if (
    report?.schemaVersion !== 1 ||
    !Array.isArray(report.cases) ||
    !Array.isArray(report.failures) ||
    !report.provenance?.packages
  ) {
    throw new Error("Expected a compiler comparison report with schemaVersion 1");
  }
  const ids = new Set();
  for (const fixture of report.cases) {
    if (
      typeof fixture.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(fixture.sourceHash ?? "") ||
      !fixture.summary ||
      ["babel", "oxc", "swc"].some((compiler) => !fixture[compiler] || !fixture.summary[compiler])
    )
      throw new Error("Incomplete fixture in compiler report");
    if (ids.has(fixture.id)) throw new Error(`Duplicate fixture in compiler report: ${fixture.id}`);
    ids.add(fixture.id);
  }
}

function normalize(value, roots) {
  if (typeof value === "string") {
    return roots.reduce(
      (text, root) => text.replaceAll(`${root}/`, "").replaceAll(root, "."),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry, roots)]),
    );
  }
  return value;
}

function diagnosticContent(value) {
  if (Array.isArray(value)) return value.map(diagnosticContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "codeframe")
        .map(([key, entry]) => [key, diagnosticContent(entry)]),
    );
  }
  return value;
}

export function compareReports(before, after) {
  validate(before);
  validate(after);
  const roots = [...new Set([before.analyzer?.cwd, after.analyzer?.cwd].filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  const previous = new Map(before.cases.map((fixture) => [fixture.id, fixture]));
  const current = new Map(after.cases.map((fixture) => [fixture.id, fixture]));
  const inputs = {
    added: after.cases.filter((fixture) => !previous.has(fixture.id)).map((fixture) => fixture.id),
    removed: before.cases
      .filter((fixture) => !current.has(fixture.id))
      .map((fixture) => fixture.id),
    changed: after.cases
      .filter(
        (fixture) =>
          previous.has(fixture.id) &&
          (fixture.sourceHash !== previous.get(fixture.id).sourceHash ||
            fixture.target !== previous.get(fixture.id).target),
      )
      .map((fixture) => fixture.id),
  };
  const summary = {
    fixturesCompared: 0,
    outcomesChanged: 0,
    diagnosticsChanged: 0,
    diagnosticContentChanged: 0,
    codegenChanged: 0,
    optionsChanged: 0,
    analyzerChanged: !isDeepStrictEqual(
      normalize(before.analyzer?.document, roots),
      normalize(after.analyzer?.document, roots),
    ),
  };
  const changes = [];
  for (const fixture of after.cases) {
    const old = previous.get(fixture.id);
    if (!old || inputs.changed.includes(fixture.id)) continue;
    summary.fixturesCompared++;
    for (const compiler of ["babel", "oxc", "swc"]) {
      const oldResult = normalize(old[compiler], roots);
      const newResult = normalize(fixture[compiler], roots);
      const flags = {
        outcomeChanged:
          !isDeepStrictEqual(old.summary[compiler], fixture.summary[compiler]) ||
          oldResult.fatal !== newResult.fatal ||
          !isDeepStrictEqual(oldResult.exception, newResult.exception),
        diagnosticsChanged: !isDeepStrictEqual(oldResult.diagnostics, newResult.diagnostics),
        diagnosticContentChanged: !isDeepStrictEqual(
          diagnosticContent(oldResult.diagnostics),
          diagnosticContent(newResult.diagnostics),
        ),
        codegenChanged: oldResult.code !== newResult.code,
        optionsChanged: !isDeepStrictEqual(oldResult.options, newResult.options),
      };
      if (!Object.values(flags).some(Boolean)) continue;
      summary.outcomesChanged += Number(flags.outcomeChanged);
      for (const key of [
        "diagnosticsChanged",
        "diagnosticContentChanged",
        "codegenChanged",
        "optionsChanged",
      ]) {
        summary[key] += Number(flags[key]);
      }
      changes.push({
        id: fixture.id,
        compiler,
        ...flags,
        before: {
          summary: old.summary[compiler],
          diagnostics: oldResult.diagnostics,
          options: oldResult.options,
        },
        after: {
          summary: fixture.summary[compiler],
          diagnostics: newResult.diagnostics,
          options: newResult.options,
        },
      });
    }
  }
  const names = [
    ...new Set([
      ...Object.keys(before.provenance.packages),
      ...Object.keys(after.provenance.packages),
    ]),
  ].sort();
  const versions = names.flatMap((name) => {
    const old = before.provenance.packages[name]?.version ?? null;
    const next = after.provenance.packages[name]?.version ?? null;
    return old === next ? [] : [{ package: name, before: old, after: next }];
  });
  return {
    schemaVersion: 1,
    comparable:
      Object.values(inputs).every((entries) => entries.length === 0) &&
      before.failures.length === 0 &&
      after.failures.length === 0,
    inputs,
    failures: { before: before.failures, after: after.failures },
    versions,
    summary,
    changes,
  };
}

function markdown(delta) {
  return [
    "# Compiler Upgrade Delta",
    "",
    `Comparable inputs and successful runs: ${delta.comparable ? "yes" : "NO"}.`,
    "",
    ...delta.versions.map(
      (entry) => `- ${entry.package}: ${entry.before ?? "absent"} -> ${entry.after ?? "absent"}`,
    ),
    "",
    ...Object.entries(delta.summary).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Counts describe compiler/fixture observations, not a correctness or performance ranking.",
    "diagnosticContentChanged excludes explicit codeframe fields; severity changes remain significant.",
    "",
    "| Fixture | Compiler | Outcome | Diagnostic content | Diagnostic payload | Codegen | Options |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...delta.changes.map(
      (entry) =>
        `| ${entry.id} | ${entry.compiler} | ${entry.outcomeChanged} | ${entry.diagnosticContentChanged} | ${entry.diagnosticsChanged} | ${entry.codegenChanged} | ${entry.optionsChanged} |`,
    ),
    "",
    `Input changes: ${JSON.stringify(delta.inputs)}`,
    "",
    `Run failures: ${JSON.stringify(delta.failures)}`,
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "latest" && args.length === 0) {
    const result = spawnSync(
      "yarn",
      ["npm", "info", ...comparisonPackages, "--fields", "name,version", "--json"],
      { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Registry query failed: ${result.stderr}`);
    const entries = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    if (
      byName.size !== comparisonPackages.length ||
      comparisonPackages.some((name) => typeof byName.get(name)?.version !== "string")
    ) {
      throw new Error("Registry query did not return every comparison package");
    }
    for (const name of comparisonPackages) console.log(JSON.stringify(byName.get(name)));
  } else if (mode === "capture" && args.length === 1) {
    const { runComparison } = await import("../../../../compiler-repros/run.mjs");
    const report = runComparison({ outputDirectory: resolve(args[0]) });
    if (report.failures.length) throw new Error(report.failures.join("; "));
    console.log(`Captured ${report.cases.length} fixtures: ${resolve(args[0], "comparison.json")}`);
  } else if (mode === "compare" && args.length === 3) {
    const delta = compareReports(
      JSON.parse(readFileSync(args[0], "utf8")),
      JSON.parse(readFileSync(args[1], "utf8")),
    );
    mkdirSync(args[2], { recursive: true });
    writeFileSync(join(args[2], "upgrade-delta.json"), `${JSON.stringify(delta, null, 2)}\n`);
    writeFileSync(join(args[2], "upgrade-delta.md"), markdown(delta));
    console.log(
      JSON.stringify(
        { comparable: delta.comparable, versions: delta.versions, summary: delta.summary },
        null,
        2,
      ),
    );
    console.log(`Delta: ${resolve(args[2], "upgrade-delta.md")}`);
    process.exitCode = delta.comparable ? 0 : 1;
  } else {
    throw new Error(
      "Usage: compare-reports.mjs latest | capture <output-dir> | compare <before.json> <after.json> <output-dir>",
    );
  }
}

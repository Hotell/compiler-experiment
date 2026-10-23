import { ArrowLeft, ArrowUpRight, Braces, FileJson, FileText } from "lucide-react";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { suppressionFinding } from "./findings.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const workspace = `${dirname(directory)}/`;
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const icon = (component) =>
  renderToStaticMarkup(
    createElement(component, {
      size: 18,
      strokeWidth: 1.7,
      "aria-hidden": true,
    }),
  );

export function publicEvidence(value) {
  if (typeof value === "string") {
    return value
      .replaceAll(workspace, "")
      .replaceAll(workspace.slice(0, -1), ".")
      .replaceAll(process.execPath, "node");
  }
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, publicEvidence(entry)]),
    );
  }
  return value;
}

function cacheLabel(summary) {
  if (summary.cacheEmitted === null) return "Unknown";
  return summary.cacheEmitted ? `${summary.slots.join(", ")} slots` : "No cache";
}

function cacheCell(summary, detail) {
  return `<span class="cache-state ${summary.cacheEmitted ? "emitted" : "not-emitted"}">${escapeHtml(cacheLabel(summary))}</span><span class="cell-detail">${escapeHtml(detail)}</span>`;
}

export function renderHtml(input) {
  const report = publicEvidence(input);
  const finding = suppressionFinding(report);
  const cacheDivergent = (fixture) =>
    Object.values(fixture.comparisons).some(
      (comparison) => comparison.cacheMismatch || comparison.slotsMismatch,
    );
  const divergent = (fixture) =>
    cacheDivergent(fixture) ||
    Object.values(fixture.comparisons).some((comparison) => comparison.diagnosticPresenceMismatch);
  const differences = report.cases.filter(cacheDivergent).length;
  const initial =
    report.cases.find(cacheDivergent) ?? report.cases.find(divergent) ?? report.cases[0];
  const rows = report.cases
    .map(
      (
        fixture,
      ) => `<tr data-row="${escapeHtml(fixture.id)}"${cacheDivergent(fixture) ? "" : " hidden"}${divergent(fixture) ? ' class="has-difference"' : ""}>
    <th scope="row"><button type="button" class="case-button" data-case="${escapeHtml(fixture.id)}" aria-pressed="${fixture.id === initial.id}">${escapeHtml(fixture.id)}${icon(ArrowUpRight)}</button></th>
    <td>${cacheCell(fixture.summary.babel, fixture.summary.babel.reason === "suppression-opt-out" ? "Suppression opt-out" : fixture.summary.babel.reportedStatus)}</td>
    <td>${cacheCell(fixture.summary.oxc, fixture.summary.oxc.reason === "suppression-opt-out" ? "Suppression opt-out" : fixture.oxc.diagnostics.length ? "Diagnostic reported" : "No diagnostic")}</td>
    <td>${cacheCell(fixture.summary.swc, fixture.swc.diagnostics.length ? "Diagnostic reported" : "No diagnostic")}</td>
    <td><span class="analyzer-state">${escapeHtml(fixture.summary.analyzer.reportedStatus)}</span><span class="cell-detail">${fixture.babelVsAnalyzer.disagreement ? "Analysis mismatch" : "Matches Babel analysis"}</span></td>
    <td><span class="verdict ${divergent(fixture) ? "different" : "aligned"}">${cacheDivergent(fixture) ? "Cache differs" : divergent(fixture) ? "Diagnostics differ" : "Matching cache"}</span></td>
  </tr>`,
    )
    .join("");
  const versions = Object.entries(report.provenance.packages)
    .filter(([name]) =>
      [
        "babel-plugin-react-compiler",
        "oxc-transform-react",
        "@swc/core",
        "@fluentui/react-compiler-analyzer",
      ].includes(name),
    )
    .map(
      ([name, info]) =>
        `<span><strong>${name === "babel-plugin-react-compiler" ? "Babel" : name === "oxc-transform-react" ? "OXC" : name === "@swc/core" ? "SWC" : "RCA"}</strong> ${escapeHtml(info.version)}</span>`,
    )
    .join("");
  const payload = JSON.stringify(report).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f6f8f8"><title>Compiler compatibility / Signal</title><style>${readFileSync(join(directory, "report.css"), "utf8")}</style></head>
<body>
  <header class="site-header"><a class="brand" href="../" aria-label="Signal comparisons"><span class="brand-mark">S<span>.</span></span><span class="brand-name">signal<span>.</span></span><span class="brand-context">compiler lab</span></a><a class="text-link" href="../">${icon(ArrowLeft)} All comparisons</a></header>
  <main class="compat-main">
    <section class="compat-heading"><div><span class="eyebrow">REACT 19 / TRANSFORM EVIDENCE</span><h1>Compiler compatibility</h1><div class="versions">${versions}</div></div><a class="text-link" href="comparison.json" download>${icon(FileJson)} Full evidence</a></section>
    <section class="metrics" aria-label="Comparison summary"><div><strong>${report.cases.length}</strong><span>isolated fixtures</span></div><div class="${differences ? "metric-difference" : ""}"><strong id="cache-differences">${differences}</strong><span>Compiler cache differences</span></div></section>
    ${finding ? `<section id="key-finding" class="key-finding" aria-label="Key finding"><span class="eyebrow">KEY FINDING</span><h2>${escapeHtml(finding.title)}</h2><p>${escapeHtml(finding.summary)}</p><p>${escapeHtml(finding.validation)}</p><p class="finding-caveat">${escapeHtml(finding.caveat)}</p><nav class="finding-evidence" aria-label="Finding evidence">${finding.evidence.map((evidence) => `<a class="text-link" href="#${escapeHtml(evidence.id)}" data-evidence-case="${escapeHtml(evidence.id)}">${escapeHtml(evidence.label)} ${icon(ArrowUpRight)}</a>`).join("")}</nav></section>` : ""}
    ${report.failures.length ? `<aside class="failure-banner" role="alert"><strong>Incomplete run</strong><ul>${report.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul></aside>` : ""}
    <section class="matrix-section" aria-labelledby="matrix-title"><div class="section-heading"><h2 id="matrix-title">Fixture matrix</h2><div class="filters"><label class="search-label"><span class="sr-only">Search fixtures</span><input id="fixture-search" type="search" placeholder="Search fixtures" autocomplete="off"></label><label><span class="sr-only">Filter outcomes</span><select id="outcome-filter"><option value="all">All outcomes</option><option value="differences" selected>Differences</option><option value="bailouts">Diagnostics</option><option value="controls">Controls &amp; guards</option></select></label><span id="visible-count" aria-live="polite">${differences} of ${report.cases.length}</span></div></div>
      <div class="table-scroll" role="region" aria-label="Compiler fixture results" tabindex="0"><table><thead><tr><th scope="col">Fixture</th><th scope="col">Babel cache</th><th scope="col">OXC cache</th><th scope="col">SWC cache</th><th scope="col">RCA analysis</th><th scope="col">Comparison</th></tr></thead><tbody>${rows}<tr id="empty-row" hidden><td colspan="6">No matching fixtures.</td></tr></tbody></table></div>
    </section>
    <section id="inspector" class="inspector" aria-labelledby="case-title"><div class="section-heading"><div><span class="eyebrow" id="case-group"></span><h2 id="case-title" tabindex="-1">${escapeHtml(initial.id)}</h2><p id="case-target" class="muted"></p></div><div class="evidence-links"><label><span class="sr-only">Compare compilers</span><select id="compiler-pair" class="pair-picker"><option value="babel-oxc">Babel / OXC</option><option value="babel-swc">Babel / SWC</option><option value="oxc-swc">OXC / SWC</option></select></label><a id="control-link" class="text-link" href="#">Control ${icon(ArrowUpRight)}</a><a id="source-link" class="text-link" href="${initial.id}.source.tsx">${icon(FileText)} Source</a><a id="diff-link" class="text-link" href="${initial.id}.diff">${icon(Braces)} Diff</a></div></div>
      <div class="evidence-tabs" role="tablist" aria-label="Evidence view"><button id="tab-compare" role="tab" aria-selected="true" aria-controls="panel-compare" data-panel="compare">Compiler output</button><button id="tab-input" role="tab" aria-selected="false" aria-controls="panel-input" data-panel="input" tabindex="-1">Input</button><button id="tab-diff" role="tab" aria-selected="false" aria-controls="panel-diff" data-panel="diff" tabindex="-1">Diff</button><button id="tab-diagnostics" role="tab" aria-selected="false" aria-controls="panel-diagnostics" data-panel="diagnostics" tabindex="-1">Diagnostics</button></div>
      <div id="panel-compare" class="output-grid" role="tabpanel" aria-labelledby="tab-compare"><section class="code-pane" id="left-output" aria-label="Babel output"><header><strong id="left-name">Babel</strong><span id="left-cache"></span></header><pre tabindex="0"><code id="left-code">${escapeHtml(initial.babel.code)}</code></pre></section><section class="code-pane" id="right-output" aria-label="OXC output"><header><strong id="right-name">OXC</strong><span id="right-cache"></span></header><pre tabindex="0"><code id="right-code">${escapeHtml(initial.oxc.code)}</code></pre></section></div>
      <div id="panel-input" class="code-pane" role="tabpanel" aria-labelledby="tab-input" hidden><header><strong>Input TSX</strong><span>Identical source for all three compilers</span></header><pre tabindex="0"><code id="input-code"></code></pre></div>
      <div id="panel-diff" class="code-pane" role="tabpanel" aria-labelledby="tab-diff" hidden><header><strong id="pair-title">Babel / OXC</strong><span>Codegen diff; TypeScript erasure included</span></header><pre id="diff-code" tabindex="0"></pre></div>
      <div id="panel-diagnostics" class="output-grid" role="tabpanel" aria-labelledby="tab-diagnostics" hidden><section class="code-pane"><header><strong id="left-diagnostic-name">Babel diagnostics</strong></header><pre id="left-diagnostics" tabindex="0"></pre></section><section class="code-pane"><header><strong id="right-diagnostic-name">OXC diagnostics</strong></header><pre id="right-diagnostics" tabindex="0"></pre></section></div>
      <p id="source-hash" class="source-hash"></p>
    </section>
    <details class="method"><summary>Method &amp; provenance</summary><p>Identical TSX inputs. Infer mode, React 19 target, default suppression handling. Babel preserves TypeScript; OXC and SWC remove it. Codegen differences do not prove semantic differences.</p><p>Cache emission is observed in generated output. RCA runs Babel with noEmit and reports analysis events, not emitted code. OXC and SWC have no per-function success logger in these APIs. SWC can omit diagnostics for unoptimized functions; diagnostic telemetry differences do not prove different acceptance. No cache without a diagnostic is not automatically a bailout.</p><p>The mutation-shaped hooks may not be discovered under infer. Their mutation-free component controls independently test computed-key lowering. Runtime correctness and performance are not measured here.</p><pre>${escapeHtml(JSON.stringify(report.provenance, null, 2))}</pre></details>
    <footer><span>BUILD-TIME EVIDENCE / NOT A PERFORMANCE BENCHMARK</span><a class="text-link" href="comparison.md">Markdown ${icon(ArrowUpRight)}</a></footer>
  </main><script type="application/json" id="comparison-data">${payload}</script><script>${readFileSync(join(directory, "report.js"), "utf8")}</script>
</body></html>`;
}

export function writePublicArtifacts(report, outputDirectory) {
  for (const name of readdirSync(outputDirectory)) {
    if (![".json", ".md", ".tsx", ".jsx", ".diff", ".txt"].includes(extname(name))) continue;
    const filename = join(outputDirectory, name);
    writeFileSync(filename, publicEvidence(readFileSync(filename, "utf8")));
  }
  writeFileSync(join(outputDirectory, "index.html"), renderHtml(report));
}

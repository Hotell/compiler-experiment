import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { diffLines } from "diff";
import { Marked, Renderer } from "marked";
import { parse, serialize } from "parse5";

const output = "dist-pages";
for (const app of ["compiler", "manual", "baseline"]) {
  const html = readFileSync(`apps/${app}/dist/index.html`, "utf8");
  assert.ok(
    html.includes(`/compiler-experiment/${app}/assets/`),
    `${app} is not built for its Pages path`,
  );
}

mkdirSync(output, { recursive: true });
cpSync("site", output, { recursive: true, force: true });
for (const app of ["compiler", "manual", "baseline"]) {
  cpSync(`apps/${app}/dist`, `${output}/${app}`, {
    recursive: true,
    force: true,
  });
}
const modules = ["App", "providers", "controls", "incidents", "main", "recorder"];
const pairs = [
  ["compiler", "baseline"],
  ["compiler", "manual"],
  ["manual", "baseline"],
];
const sourcesDirectory = `${output}/sources`;
mkdirSync(sourcesDirectory, { recursive: true });
const sources = Object.fromEntries(
  ["compiler", "manual", "baseline"].map((app) => [
    app,
    Object.fromEntries(
      modules.map((name) => {
        const source = readFileSync(`${output}/${app}/sources/${name}.js`, "utf8");
        assert.ok(source.includes("\n"), `${app}/${name} is not readable source`);
        return [name, source];
      }),
    ),
  ]),
);
assert.match(sources.compiler.App, /from "react\/compiler-runtime"/);
for (const app of ["manual", "baseline"])
  assert.doesNotMatch(sources[app].App, /from "react\/compiler-runtime"/);

const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function sourcePage(left, right, name) {
  let leftLine = 1;
  let rightLine = 1;
  let addedLines = 0;
  let removedLines = 0;
  const lines = diffLines(sources[left][name], sources[right][name])
    .flatMap(({ value, added, removed }) => {
      const parts = value.split("\n");
      if (value.endsWith("\n")) parts.pop();
      return parts.map((part) => {
        const before = added ? "" : leftLine++;
        const after = removed ? "" : rightLine++;
        if (added) addedLines++;
        if (removed) removedLines++;
        const kind = added ? "added" : removed ? "removed" : "unchanged";
        const marker = added ? "+" : removed ? "-" : " ";
        return `<span class="diff-line ${kind}"><span class="diff-number">${before}</span><span class="diff-number">${after}</span><code>${marker} ${escapeHtml(part)}</code></span>`;
      });
    })
    .join("");
  const pair = `${left}-${right}`;
  const pairOptions = pairs
    .map(
      ([first, second]) =>
        `<option value="${first}-${second}"${pair === `${first}-${second}` ? " selected" : ""}>${first} vs. ${second}</option>`,
    )
    .join("");
  const moduleOptions = modules
    .map(
      (module) =>
        `<option value="${module}"${name === module ? " selected" : ""}>${module}.js</option>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="theme-color" content="#f6f8f8" /><title>${name}.js / Compiled sources / Signal</title><link rel="stylesheet" href="../styles.css" /><link rel="stylesheet" href="../source.css" /></head>
  <body class="source-page">
    <header class="site-header"><div class="brand"><span class="brand-mark" aria-hidden="true">S<span>.</span></span><span class="brand-name">signal<span>.</span></span><span class="brand-divider" aria-hidden="true"></span><span class="brand-context">compiled sources</span></div><a class="source-link" href="../">All implementations <span aria-hidden="true">↗</span></a></header>
    <main class="source-main"><div class="source-heading"><div><span class="eyebrow">PRODUCTION / POST-TRANSFORM / PRE-BUNDLE</span><h1>Compiled sources</h1></div><span class="source-summary">${removedLines} removed · ${addedLines} added</span></div>
      <div class="source-toolbar"><label>Compare<select id="pair">${pairOptions}</select></label><label>Module<select id="module">${moduleOptions}</select></label><div class="source-raw"><a href="../${left}/sources/${name}.js">${left} source ↗</a><a href="../${right}/sources/${name}.js">${right} source ↗</a></div></div>
      <div class="source-diff" role="region" aria-label="${left} versus ${right} ${name}.js diff" tabindex="0"><div class="diff-header"><span>${left}</span><span>${right}</span><span>${name}.js</span></div><pre class="diff">${lines}</pre></div>
    </main>
    <script>for (const select of document.querySelectorAll(".source-toolbar select")) select.addEventListener("change", () => { location.href = "./" + document.getElementById("pair").value + "-" + document.getElementById("module").value + ".html"; });</script>
  </body>
</html>`;
}
for (const [left, right] of pairs)
  for (const name of modules)
    writeFileSync(
      `${sourcesDirectory}/${left}-${right}-${name}.html`,
      sourcePage(left, right, name),
    );
writeFileSync(`${sourcesDirectory}/index.html`, sourcePage("compiler", "baseline", "App"));
const analyzerDirectory = `${output}/analyzer`;
mkdirSync(analyzerDirectory, { recursive: true });
const analyzerDocument = parse(
  execFileSync(
    "yarn",
    [
      "exec",
      "react-compiler-analyzer",
      "analyze",
      "apps/compiler/src",
      "shared",
      "benchmark/recorder.tsx",
      "--format",
      "html",
      "--verbose",
    ],
    { encoding: "utf8" },
  ),
);
const analyzerHead = analyzerDocument.childNodes
  .find((node) => node.nodeName === "html")
  ?.childNodes.find((node) => node.nodeName === "head");
assert.ok(analyzerHead, "Analyzer report is missing its document head");
analyzerHead.childNodes.push({
  nodeName: "link",
  tagName: "link",
  attrs: [
    { name: "rel", value: "stylesheet" },
    { name: "href", value: "../analyzer.css" },
  ],
  namespaceURI: "http://www.w3.org/1999/xhtml",
  childNodes: [],
  parentNode: analyzerHead,
});
writeFileSync(`${analyzerDirectory}/index.html`, serialize(analyzerDocument));
const reportDirectory = `${output}/report`;
mkdirSync(reportDirectory, { recursive: true });
const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
assert.ok(report.evaluation?.recommendation, "Benchmark comparison is missing its evaluation");
const defaultTable = Renderer.prototype.table;
const markdown = new Marked({ gfm: true });
markdown.use({
  renderer: {
    table(token) {
      return `<div class="report-table-scroll">${defaultTable.call(this, token)}</div>`;
    },
  },
});
const artifacts = [
  "comparison.md",
  "comparison.json",
  "slowdown.json",
  "selection-latency.json",
  ...["compiler", "manual", "baseline"].flatMap((app) => [
    `favorite-${app}.svg`,
    `favorite-${app}.cpuprofile`,
    `lighthouse-${app}.json`,
  ]),
];
for (const artifact of artifacts)
  cpSync(`benchmark/results/${artifact}`, `${reportDirectory}/${artifact}`);
const runId = process.env.BENCHMARK_RUN_ID;
const commit = process.env.BENCHMARK_SHA?.slice(0, 7);
const runUrl = runId
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "Hotell/compiler-experiment"}/actions/runs/${runId}`
  : null;
writeFileSync(
  `${reportDirectory}/index.html`,
  `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="theme-color" content="#f6f8f8" /><title>Benchmark comparison / Signal</title><link rel="stylesheet" href="../styles.css" /><link rel="stylesheet" href="../report.css" /></head>
  <body class="report-page">
    <header class="site-header"><div class="brand"><span class="brand-mark" aria-hidden="true">S<span>.</span></span><span class="brand-name">signal<span>.</span></span><span class="brand-divider" aria-hidden="true"></span><span class="brand-context">benchmark comparison</span></div><a class="source-link" href="../">All implementations <span aria-hidden="true">↗</span></a></header>
    <main class="report-main"><div class="report-topline"><span class="eyebrow"><span class="live-dot" aria-hidden="true"></span> LATEST SUCCESSFUL BENCHMARK</span>${runUrl ? `<a href="${runUrl}">CI run ${runId}${commit ? ` · ${commit}` : ""} ↗</a>` : "<span>Local benchmark preview</span>"}</div><article class="report-body">${markdown.parse(readFileSync("benchmark/results/comparison.md", "utf8"))}</article><footer><span>PRODUCTION BUILD MEASUREMENTS · REACT 19</span><a href="../">ALL IMPLEMENTATIONS ↑</a></footer></main>
  </body>
</html>`,
);
writeFileSync(`${output}/.nojekyll`, "");
console.log(`Assembled ${output}/ with chooser, source comparison, report and three apps.`);

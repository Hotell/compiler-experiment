import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { diffLines } from "diff";
import { Marked, Renderer } from "marked";
import { parse, parseFragment, serialize } from "parse5";
import { hashFiles, validateProvenance } from "./benchmark-provenance.mjs";
import { ablationFiles, loadAblationEvidence } from "./report-evidence.mjs";
import { reportSections } from "./report-markdown.mjs";

const output = "dist-pages";
const appLabels = {
  compiler: "React Compiler",
  manual: "Manual memoization",
  baseline: "No memoization",
};
const report = JSON.parse(readFileSync("benchmark/results/comparison.json", "utf8"));
validateProvenance(report.provenance, "benchmark/results");
assert.deepEqual(
  report.rowMemo,
  loadAblationEvidence(report),
  "Ablation evidence changed since reporting; regenerate the main comparison before publishing",
);
for (const app of ["compiler", "manual"]) {
  const captured = `sources/${app}-App.js`;
  const expected = report.provenance.builds[app].production["./sources/App.js"];
  assert.equal(
    hashFiles("benchmark/results", [captured])[captured],
    expected,
    "Captured source snapshot changed",
  );
  assert.equal(
    hashFiles(`apps/${app}/dist`, ["sources/App.js"])["sources/App.js"],
    expected,
    "Pages source snapshot differs from measured output",
  );
}
for (const app of ["compiler", "manual", "baseline"]) {
  const html = readFileSync(`apps/${app}/dist/index.html`, "utf8");
  assert.ok(
    html.includes(`/compiler-experiment/${app}/assets/`),
    `${app} is not built for its Pages path`,
  );
  const profile = readFileSync(`apps/${app}/dist-profile-pages/index.html`, "utf8");
  assert.ok(
    profile.includes(`/compiler-experiment/profile/${app}/assets/`),
    `${app} is not built for its profiling Pages path`,
  );
}

mkdirSync(output, { recursive: true });
cpSync("site", output, { recursive: true, force: true });
for (const app of ["compiler", "manual", "baseline"]) {
  cpSync(`apps/${app}/dist`, `${output}/${app}`, {
    recursive: true,
    force: true,
  });
  const profileDirectory = `${output}/profile/${app}`;
  cpSync(`apps/${app}/dist-profile-pages`, profileDirectory, { recursive: true, force: true });
  const document = parse(readFileSync(`${profileDirectory}/index.html`, "utf8"));
  const html = document.childNodes.find((node) => node.nodeName === "html");
  const head = html?.childNodes.find((node) => node.nodeName === "head");
  const body = html?.childNodes.find((node) => node.nodeName === "body");
  const title = head?.childNodes.find((node) => node.nodeName === "title");
  assert.ok(head && body && title, `${app} profiling document is incomplete`);
  title.childNodes = [
    {
      nodeName: "#text",
      value: `Signal / ${appLabels[app]} / Profiling enabled`,
      parentNode: title,
    },
  ];
  const stylesheet = parseFragment('<link rel="stylesheet" href="../../profile.css">')
    .childNodes[0];
  stylesheet.parentNode = head;
  head.childNodes.push(stylesheet);
  const banner = parseFragment(`<aside class="profile-banner" aria-label="Profiling build">
    <div class="profile-banner-heading"><strong>Profiling enabled</strong><span>${appLabels[app]}</span><span>Production build / diagnostic overhead</span></div>
    <nav aria-label="Profiling navigation"><a href="../../">All implementations</a><a href="../../${app}/">Open normal build</a></nav>
    <details><summary>How to profile</summary>
      <p>Install the React DevTools browser extension and open its Profiler tab. Start recording, interact with the app, then stop recording.</p>
      <p>Our callback records also remain available in the console as <code>window.__benchmark.records</code>, including <code>actualDuration</code> and <code>baseDuration</code>. Use <code>window.__benchmark.clear()</code> between recordings to discard accumulated samples. Nothing is uploaded.</p>
      <p>Profiling adds overhead. These pages are for diagnosis, not the published production-size or latency comparison.</p>
    </details>
  </aside>`).childNodes[0];
  banner.parentNode = body;
  body.childNodes.unshift(banner);
  writeFileSync(`${profileDirectory}/index.html`, serialize(document));
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
assert.ok(report.evaluation?.recommendation, "Benchmark comparison is missing its evaluation");
const defaultTable = Renderer.prototype.table;
const defaultHeading = Renderer.prototype.heading;
const defaultParagraph = Renderer.prototype.paragraph;
const markdown = new Marked({ gfm: true });
markdown.use({
  renderer: {
    paragraph(token) {
      const links = token.tokens.filter((entry) => entry.type === "link");
      if (
        links.length === reportSections.length &&
        links.every((link, index) => link.href === `#${reportSections[index].id}`)
      ) {
        return `<nav class="report-nav" aria-label="Report sections">${links.map((link) => this.parser.parseInline([link])).join("")}</nav>`;
      }
      return defaultParagraph.call(this, token);
    },
    heading(token) {
      const section =
        token.depth === 2 && reportSections.find((entry) => entry.title === token.text);
      if (section) return `<h2 id="${section.id}">${this.parser.parseInline(token.tokens)}</h2>`;
      const heading = defaultHeading.call(this, token);
      if (token.depth !== 3 || token.text !== "Reading the Profiler durations") return heading;
      return `${heading}<nav aria-label="Try profiling these apps"><p><strong>Try profiling these apps:</strong> ${[
        "baseline",
        "manual",
        "compiler",
      ]
        .map((app) => `<a href="../profile/${app}/">${appLabels[app]}</a>`)
        .join(
          " / ",
        )}.</p><p>Open React DevTools, select its Profiler tab, and record an interaction. These production profiling builds include diagnostic overhead; normal builds remain the basis for the size and latency comparisons.</p></nav>`;
    },
    table(token) {
      return `<div class="report-table-scroll">${defaultTable.call(this, token)}</div>`;
    },
  },
});
const artifacts = [
  "measurements.json",
  "provenance.json",
  "comparison.md",
  "comparison.json",
  "lighthouse.json",
  "load-memory.json",
  "sources/compiler-App.js",
  "sources/manual-App.js",
  "slowdown.json",
  "selection-latency.json",
  "filtering-latency.json",
  ...["compiler", "manual", "baseline"].flatMap((app) => [
    `favorite-${app}.svg`,
    `favorite-${app}.cpuprofile`,
    `lighthouse-${app}.json`,
  ]),
];
mkdirSync(`${reportDirectory}/sources`, { recursive: true });
for (const artifact of artifacts)
  cpSync(`benchmark/results/${artifact}`, `${reportDirectory}/${artifact}`);
rmSync(`${reportDirectory}/row-memo`, { recursive: true, force: true });
if (report.rowMemo.status === "available") {
  mkdirSync(`${reportDirectory}/row-memo`, { recursive: true });
  for (const artifact of ablationFiles)
    cpSync(`benchmark/results/row-memo/${artifact}`, `${reportDirectory}/row-memo/${artifact}`);
}
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
    <main class="report-main"><div class="report-topline"><span class="eyebrow"><span class="live-dot" aria-hidden="true"></span> LATEST SUCCESSFUL BENCHMARK</span>${runUrl ? `<a href="${runUrl}">CI run ${runId}${commit ? ` · ${commit}` : ""} ↗</a>` : "<span>Local benchmark preview</span>"}</div><article class="report-body"><p><a href="../sources/compiler-manual-App.html">Compare compiled sources</a></p>${markdown.parse(readFileSync("benchmark/results/comparison.md", "utf8"))}</article><footer><span>PRODUCTION BUILD MEASUREMENTS · REACT 19</span><a href="../">ALL IMPLEMENTATIONS ↑</a></footer></main>
  </body>
</html>`,
);
writeFileSync(`${output}/.nojekyll`, "");
console.log(`Assembled ${output}/ with chooser, source comparison, report and six app routes.`);

import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Marked, Renderer } from "marked";

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
console.log(`Assembled ${output}/ with chooser, report, compiler, manual and baseline apps.`);

import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const anchors = [
  "Live workspace",
  "row:",
  "No incidents match your filters.",
  "No incident selected",
  "className:`app`",
];

for (const app of ["compiler", "baseline"]) {
  const entry = readFileSync(`apps/${app}/src/main.tsx`, "utf8");
  assert.match(entry, /import App from "\.\.\/\.\.\/\.\.\/shared\/App";/);
}

for (const path of ["shared/App.tsx", "apps/manual/src/App.tsx"]) {
  const source = readFileSync(path, "utf8");
  for (const component of ["Button", "TextInput", "Select", "StatusBadge"]) {
    assert.match(source, new RegExp(`<${component}\\b`), `${path} missing ${component}`);
  }
}

for (const app of ["compiler", "manual", "baseline"]) {
  const directory = `apps/${app}/dist`;
  const manifest = JSON.parse(readFileSync(`${directory}/.vite/manifest.json`, "utf8"));
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  assert.ok(entry, `Missing ${app} app entry`);
  const source = readFileSync(`${directory}/${entry.file}`, "utf8");
  assert.ok(
    !source.includes("__benchmark"),
    `${app} normal build includes profile instrumentation`,
  );
  for (const anchor of anchors) {
    const offset = source.indexOf(anchor);
    assert.ok(offset >= 0, `${app} missing hotspot ${anchor}`);
    const functionStart = source.lastIndexOf("function ", offset);
    const functionBody = source.slice(functionStart, offset);
    const hasCache = /\.c\)\(\d+\)/.test(functionBody);
    assert.equal(
      hasCache,
      app === "compiler",
      `${app} ${anchor} compiler cache transform mismatch`,
    );
  }
  console.log(
    `${app}: all representative hotspots have the expected cache behavior; normal build has no recorder.`,
  );
}

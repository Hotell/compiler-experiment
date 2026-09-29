import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { strict as assert } from "node:assert";

export function measureBundle(directory) {
  const manifest = JSON.parse(readFileSync(`${directory}/.vite/manifest.json`, "utf8"));
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  assert.equal(entries.length, 1, `${directory} must have exactly one entry chunk`);
  const visited = new Set();
  const files = { js: new Set(), css: new Set() };
  const loadedLater = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const item = manifest[key];
    assert.ok(item, `${directory} is missing manifest chunk ${key}`);
    if (item.file.endsWith(".js")) files.js.add(item.file);
    for (const css of item.css ?? []) files.css.add(css);
    for (const dependency of item.imports ?? []) visit(dependency);
    for (const dependency of item.dynamicImports ?? []) loadedLater.add(dependency);
  }
  visit(entries[0]);
  function sizes(paths) {
    return [...paths].reduce(
      (total, path) => {
        const bytes = readFileSync(`${directory}/${path}`);
        total.raw += bytes.length;
        total.gzip += gzipSync(bytes).length;
        return total;
      },
      { raw: 0, gzip: 0 },
    );
  }
  const js = sizes(files.js);
  const css = sizes(files.css);
  assert.ok(js.raw > 0 && css.raw > 0, `${directory} needs nonzero entry JS and CSS`);
  return {
    js,
    css,
    total: { raw: js.raw + css.raw, gzip: js.gzip + css.gzip },
    files: { js: [...files.js], css: [...files.css] },
    loadedLater: [...loadedLater],
  };
}

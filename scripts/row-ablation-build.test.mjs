import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { minify } from "rolldown/utils";
import { resolveConfig, transformWithOxc } from "vite";
import { hashFiles, sourceFingerprint } from "./benchmark-provenance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const appRoot = join(root, "apps/manual");
const flag = "__ROW_MEMO_ENABLED__";
const metadataPlugin = "manual-row-memo-metadata";

async function config({
  arm,
  mode = "production",
  command = "build",
  pagesBase,
  isPreview = false,
  nodeEnv,
} = {}) {
  const environment = {
    ROW_MEMO_ABLATION: arm,
    PAGES_BASE: pagesBase,
    NODE_ENV: nodeEnv,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  function set(values) {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  set(environment);
  try {
    return await resolveConfig(
      { root: appRoot, configFile: join(appRoot, "vite.config.ts"), mode, logLevel: "silent" },
      command,
      mode,
      command === "build" ? "production" : "development",
      isPreview,
    );
  } finally {
    set(previous);
  }
}

function parse(code, filename = "App.tsx") {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0);
  return source;
}

function all(source, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function declaration(source, name) {
  const matches = all(
    source,
    (node) => ts.isVariableDeclaration(node) && node.name.getText() === name,
  );
  assert.equal(matches.length, 1, `one ${name} declaration`);
  return matches[0];
}

function calls(source, name) {
  return all(source, (node) => ts.isCallExpression(node) && node.expression.getText() === name);
}

test("ordinary manual builds and dev retain memo-on, their directories, and Pages support", async () => {
  for (const [mode, command, pagesBase, outDir] of [
    ["production", "build", undefined, "dist"],
    ["profile", "build", undefined, "dist-profile"],
    ["development", "serve", undefined, "dist"],
    ["production", "build", "/compiler-experiment/manual/", "dist"],
  ]) {
    const resolved = await config({ mode, command, pagesBase });
    assert.equal(resolved.define[flag], true);
    assert.equal(resolved.build.outDir, outDir);
    assert.equal(resolved.base, pagesBase ?? "/");
    assert.equal(resolved.build.manifest, true);
    assert.ok(!resolved.plugins.some((plugin) => plugin.name === metadataPlugin));
    assert.equal(
      resolved.plugins.some((plugin) => plugin.name === "source-snapshots"),
      mode === "production",
    );
  }
});

test("real Vite config rejects every non-enum flag, including defined blanks", async () => {
  for (const arm of ["", " ", "ON", "OFF", "true", "false", "0", "1", "on ", "undefined"]) {
    await assert.rejects(config({ arm }), /ROW_MEMO_ABLATION must be exactly 'on' or 'off'/);
  }
});

test("real Vite config rejects dev, preview, unsupported modes, and any defined Pages base", async () => {
  for (const arm of ["on", "off"]) {
    for (const mode of ["production", "profile", "development"]) {
      await assert.rejects(config({ arm, mode, command: "serve" }), /only supported by vite build/);
    }
    await assert.rejects(
      config({ arm, command: "serve", isPreview: true }),
      /only supported by vite build/,
    );
    for (const mode of ["development", "staging", "test", ""]) {
      await assert.rejects(config({ arm, mode }), /requires production or profile mode/);
    }
    for (const pagesBase of ["", "/", "/compiler-experiment/manual/"]) {
      await assert.rejects(config({ arm, pagesBase }), /cannot be combined with PAGES_BASE/);
    }
  }
});

test("ablation builds cannot silently use a development React bundle", async () => {
  for (const mode of ["production", "profile"]) {
    for (const nodeEnv of ["development", "test"]) {
      await assert.rejects(config({ arm: "on", mode, nodeEnv }), /requires NODE_ENV=production/);
    }
    for (const nodeEnv of ["production", ""]) {
      assert.equal((await config({ arm: "off", mode, nodeEnv })).isProduction, true);
    }
  }
});

test("four real Vite configs isolate outputs and emit agreeing build-only metadata", async () => {
  const directories = new Set();
  const fingerprints = new Set();
  for (const arm of ["on", "off"]) {
    for (const mode of ["production", "profile"]) {
      const resolved = await config({ arm, mode });
      assert.equal(resolved.define[flag], arm === "on");
      assert.equal(resolved.base, "/");
      assert.equal(resolved.build.outDir, `dist-ablation/${arm}/${mode}`);
      assert.equal(resolved.build.manifest, true);
      assert.equal(resolved.build.minify, "oxc");
      directories.add(resolved.build.outDir);
      assert.equal(
        resolved.resolve.alias.find((alias) => alias.find === "react-dom/client")?.replacement,
        mode === "profile" ? "react-dom/profiling" : undefined,
      );
      assert.ok(!resolved.plugins.some((plugin) => /compiler|source-snapshots/.test(plugin.name)));
      const plugins = resolved.plugins.filter((plugin) => plugin.name === metadataPlugin);
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].apply, "build");
      const emitted = [];
      assert.throws(
        () => plugins[0].generateBundle.call({ emitFile: (asset) => emitted.push(asset) }),
        /sources changed during the build/,
        "metadata needs a fingerprint captured before bundling",
      );
      plugins[0].buildStart();
      await plugins[0].generateBundle.call({ emitFile: (asset) => emitted.push(asset) });
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, "asset");
      assert.equal(emitted[0].fileName, "ablation.json");
      const metadata = JSON.parse(emitted[0].source);
      assert.deepEqual(metadata, {
        schemaVersion: 1,
        experiment: "manual-row-memo",
        arm,
        mode,
        reactVersion: "19.3.0",
        sourceFingerprint: sourceFingerprint(),
      });
      assert.match(metadata.sourceFingerprint, /^[a-f0-9]{64}$/);
      fingerprints.add(metadata.sourceFingerprint);
      assert.ok(!JSON.stringify(resolved.define).includes(metadata.sourceFingerprint));
    }
  }
  assert.equal(directories.size, 4);
  assert.equal(fingerprints.size, 1);
  const viteSource = parse(readFileSync(join(appRoot, "vite.config.ts"), "utf8"), "vite.config.ts");
  assert.equal(calls(viteSource, "react").length, 1);
  assert.equal(calls(viteSource, "react")[0].arguments.length, 0, "no compiler plugin options");
});

test("fingerprint covers sorted source paths and contents, not builds or git state", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-row-ablation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = {
    "apps/manual/src/App.tsx": "app",
    "apps/manual/src/nested/another.ts": "nested app source",
    "apps/manual/src/providers.tsx": "providers",
    "apps/manual/src/main.tsx": "entry",
    "shared/controls.tsx": "controls",
    "shared/incidents.ts": "data",
    "shared/styles.css": "styles",
    "apps/manual/index.html": "html",
    "apps/manual/package.json": "app manifest",
    "apps/manual/tsconfig.json": "typescript config",
    "apps/manual/vite.config.ts": "vite config",
    "apps/manual/row-ablation.mjs": "build helper",
    "scripts/benchmark-provenance.mjs": "provenance helper",
    "scripts/run-benchmark.mjs": "runner",
    "scripts/source-snapshots.mjs": "source snapshots",
    "playwright.config.ts": "main runner config",
    "playwright.ablation.config.ts": "ablation runner config",
    "benchmark/recorder.tsx": "profiler",
    "benchmark/collection.ts": "collection",
    "benchmark/fiber-recorder.ts": "fiber instrumentation",
    "package.json": "root manifest",
    "yarn.lock": "lockfile",
  };
  for (const app of ["compiler", "baseline"]) {
    for (const name of [
      "index.html",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "src/main.tsx",
    ])
      files[`apps/${app}/${name}`] = `${app}/${name}`;
  }
  function write(path, contents) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  for (const [path, content] of Object.entries(files).reverse()) write(path, content);
  const expected = createHash("sha256").update(
    JSON.stringify(hashFiles(directory, Object.keys(files))),
  );
  const original = sourceFingerprint(directory);
  assert.equal(original, expected.digest("hex"));
  for (const [path, content] of Object.entries(files)) {
    write(path, `${content} changed`);
    assert.notEqual(sourceFingerprint(directory), original, `${path} must affect fingerprint`);
    write(path, content);
  }
  for (const path of [
    "apps/manual/dist/index.html",
    "apps/manual/dist-profile/index.html",
    "apps/manual/dist-ablation/on/production/ablation.json",
    "benchmark/results/results.json",
    ".git/HEAD",
    "plan.md",
  ]) {
    write(path, "not a source input");
    assert.equal(sourceFingerprint(directory), original, `${path} is not hashed`);
  }
  write("apps/manual/src/new.ts", "new source");
  assert.notEqual(sourceFingerprint(directory), original);
  rmSync(join(directory, "apps/manual/src/new.ts"));
  rmSync(join(directory, "benchmark/recorder.tsx"));
  assert.throws(() => sourceFingerprint(directory), /ENOENT/, "missing source must fail closed");
});

test("the sole intervention is the outer row memo; child memo and callbacks remain", () => {
  const source = parse(readFileSync(join(appRoot, "src/App.tsx"), "utf8"));
  const selection = declaration(source, "IncidentRow").initializer;
  assert.ok(ts.isConditionalExpression(selection));
  assert.equal(selection.condition.getText(), flag);
  assert.equal(selection.whenTrue.getText(), "memo(IncidentRowImpl)");
  assert.equal(selection.whenFalse.getText(), "IncidentRowImpl");
  assert.equal(
    all(source, (node) => ts.isIdentifier(node) && node.text === flag).length,
    2,
    "only a type declaration and the row selection reference the build flag",
  );
  const implementations = all(
    source,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "IncidentRowImpl",
  );
  assert.equal(implementations.length, 1);
  assert.equal(calls(implementations[0], "useCallback").length, 2);
  assert.deepEqual(
    calls(source, "memo").map((node) =>
      ts.isFunctionExpression(node.arguments[0])
        ? node.arguments[0].name.text
        : node.arguments[0].getText(),
    ),
    ["QueueItem", "OpenIncidentButton", "FavoriteButton", "IncidentRowImpl", "Detail"],
  );
  assert.equal(calls(source, "useCallback").length, 3);
  assert.equal(calls(source, "useMemo").length, 1);
  for (const [name, body, dependencies] of [
    ["selectQueue", "onSelect(item)", "[item, onSelect]"],
    ["openIncident", "setSelectedId(incident.id)", "[incident.id, setSelectedId]"],
    ["toggleIncidentFavorite", "toggleFavorite(incident.id)", "[incident.id, toggleFavorite]"],
  ]) {
    const callback = declaration(source, name).initializer;
    assert.equal(callback.expression.getText(), "useCallback");
    assert.equal(callback.arguments[0].body.getText(), body);
    assert.equal(callback.arguments[1].getText(), dependencies);
  }
  const providers = parse(readFileSync(join(appRoot, "src/providers.tsx"), "utf8"));
  assert.equal(calls(providers, "useMemo").length, 7);
  assert.equal(calls(providers, "useCallback").length, 3);
  assert.equal(all(providers, (node) => ts.isIdentifier(node) && node.text === flag).length, 0);
});

test("Vite's resolved defines change only the row selection and permit complete branch removal", async () => {
  const path = join(appRoot, "src/App.tsx");
  const source = readFileSync(path, "utf8");
  const normalized = [];
  for (const arm of ["on", "off"]) {
    const resolved = await config({ arm });
    const transformed = await transformWithOxc(source, path, {
      define: { [flag]: JSON.stringify(resolved.define[flag]) },
      jsx: { runtime: "automatic" },
    });
    assert.equal(transformed.errors.length, 0);
    assert.ok(!transformed.code.includes(flag), "no runtime flag or global marker");
    const declarationNode = declaration(parse(transformed.code, "App.js"), "IncidentRow");
    const selection = declarationNode.initializer;
    assert.ok(ts.isConditionalExpression(selection));
    assert.equal(selection.condition.getText(), arm === "on" ? "true" : "false");
    assert.equal(selection.whenTrue.getText(), "memo(IncidentRowImpl)");
    assert.equal(selection.whenFalse.getText(), "IncidentRowImpl");
    normalized.push(transformed.code.replace(selection.getText(), "IncidentRowImpl"));
    const optimized = await minify(
      "row.js",
      `const ${declarationNode.getText()}; export { IncidentRow };`,
      { mangle: false, compress: true },
    );
    assert.deepEqual(optimized.errors, []);
    const optimizedSource = parse(optimized.code, "row.js");
    assert.equal(all(optimizedSource, ts.isConditionalExpression).length, 0);
    assert.equal(
      declaration(optimizedSource, "IncidentRow").initializer.getText(),
      arm === "on" ? "memo(IncidentRowImpl)" : "IncidentRowImpl",
    );
  }
  assert.equal(normalized[0], normalized[1], "the rest of the transformed module is identical");
});

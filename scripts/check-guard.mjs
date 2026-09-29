import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "compiler-lint-guard-"));
const scopes = [
  ["apps/compiler/src/**", "apps/compiler/src/policy-fixture.tsx"],
  ["apps/baseline/src/**", "apps/baseline/src/policy-fixture.tsx"],
  ["shared/**", "shared/policy-fixture.tsx"],
  ["benchmark/recorder.tsx", "benchmark/recorder.tsx"],
];
const restrictedFiles = scopes.map(([, file]) => file);
const files = [
  ...restrictedFiles,
  "apps/manual/src/policy-fixture.tsx",
  "benchmark/policy-fixture.tsx",
];
const apis = ["memo", "useMemo", "useCallback"];
const importRule = "no-restricted-imports";
const propertyRule = "no-restricted-properties";
const imports = apis.map((api) => ({ code: `eslint(${importRule})`, text: `'${api}'` }));
const properties = apis.map((api) => ({ code: `eslint(${propertyRule})`, text: `'${api}'` }));
const namespaceImport = { code: `eslint(${importRule})`, text: "* import" };
const members = (object) => apis.map((api) => `${object}.${api}`).join(", ");
const exported = (expression) => `export const values = [${expression}];`;
const aliasedNames = apis.map((api, index) => `${api} as manual${index}`).join(", ");
const aliasedValues = apis.map((_, index) => `manual${index}`).join(", ");
const fixtures = [
  {
    name: "named imports",
    source: `import { ${apis.join(", ")} } from "react"; ${exported(apis.join(", "))}`,
    expected: imports,
  },
  {
    name: "aliased named imports",
    source: `import { ${aliasedNames} } from "react"; ${exported(aliasedValues)}`,
    expected: imports,
  },
  ...["React", "R"].flatMap((object) => [
    {
      name: `${object} default members`,
      source: `import ${object} from "react"; ${exported(members(object))}`,
      expected: properties,
    },
    {
      name: `${object} namespace members`,
      source: `import * as ${object} from "react"; ${exported(members(object))}`,
      expected: [namespaceImport, ...properties],
    },
  ]),
  {
    name: "static string computed members",
    source: `import R from "react"; ${exported(apis.map((api) => `R["${api}"]`).join(", "))}`,
    expected: properties,
  },
  {
    name: "static template computed members",
    source: `import R from "react"; ${exported(apis.map((api) => `R[\`${api}\`]`).join(", "))}`,
    expected: properties,
  },
  {
    name: "destructured members",
    source: `import R from "react"; export const { ${apis.join(", ")} } = R;`,
    expected: properties,
  },
  {
    name: "aliased destructured members",
    source: `import R from "react"; const { ${apis.map((api, index) => `${api}: manual${index}`).join(", ")} } = R; ${exported(aliasedValues)}`,
    expected: properties,
  },
  {
    name: "named re-exports",
    source: `export { ${apis.join(", ")} } from "react";`,
    expected: imports,
  },
  {
    name: "aliased re-exports",
    source: `export { ${aliasedNames} } from "react";`,
    expected: imports,
  },
  {
    name: "star re-export",
    source: 'export * from "react";',
    expected: [namespaceImport],
  },
  {
    name: "namespace re-export",
    source: 'export * as R from "react";',
    expected: [namespaceImport],
  },
  {
    name: "property-name convention applies to unrelated objects",
    source: `const cache = { memo: 1, useMemo: 2, useCallback: 3 }; ${exported(members("cache"))}`,
    expected: properties,
  },
  {
    name: "Profiler, ordinary hooks and React types",
    source: `
      import { Profiler, useState, type ReactNode, type ProfilerOnRenderCallback } from "react";
      const onRender: ProfilerOnRenderCallback = () => {};
      export function Fixture({ children }: { children: ReactNode }) {
        const [value] = useState(0);
        return <Profiler id="fixture" onRender={onRender}>{value}{children}</Profiler>;
      }
    `,
    expected: [],
  },
  {
    name: "ordinary default member",
    source: `
      import R from "react";
      export function Fixture() {
        const [value] = R.useState(0);
        return <span>{value}</span>;
      }
    `,
    expected: [],
  },
  {
    name: "native rule rejects even ordinary namespace imports",
    source: 'import * as R from "react"; export const state = R.useState;',
    expected: [namespaceImport],
  },
  {
    name: "correct manual memoization",
    source: `
      import { memo, useMemo, useCallback } from "react";
      export const Fixture = memo(function Fixture({ value }: { value: number }) {
        const doubled = useMemo(() => value * 2, [value]);
        const onClick = useCallback(() => doubled, [doubled]);
        return <button onClick={onClick}>{doubled}</button>;
      });
    `,
    expected: imports,
  },
  // These positive characterizations document native-rule gaps, not approved source conventions.
  {
    name: "dynamic property keys are not resolved",
    source: `import R from "react"; const key = "memo"; ${exported("R[key]")}`,
    expected: [],
  },
  {
    name: "indirect imports are not traced",
    source: (file) =>
      `import { ${aliasedValues} } from "./${relative(dirname(file), "benchmark/memo-barrel").replaceAll("\\", "/")}"; ${exported(aliasedValues)}`,
    expected: [],
  },
];

function writeFixture(file, source) {
  const path = join(temporaryRoot, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function lint(config, paths) {
  // Use cwd-relative config paths to avoid macOS temporary-directory symlink mismatches.
  const result = spawnSync(
    join(root, "node_modules/.bin/oxlint"),
    ["--config", relative(temporaryRoot, config), "--no-ignore", "--format", "json", ...paths],
    { cwd: temporaryRoot, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Linter terminated: ${result.signal}`);
  assert.equal(result.stderr, "", `Unexpected linter stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output.diagnostics), `Invalid linter output: ${result.stdout}`);
  assert.equal(output.number_of_files, paths.length, "Every fixture must be linted");
  assert.equal(
    result.status,
    output.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0,
    `Unexpected lint exit: ${result.stdout}`,
  );
  return output.diagnostics;
}

function lintFixture(config, fixture) {
  for (const file of files) {
    writeFixture(
      file,
      typeof fixture.source === "function" ? fixture.source(file) : fixture.source,
    );
  }
  return lint(config, files);
}

function assertPolicy(diagnostics, fixture, protectedFiles = restrictedFiles) {
  assert.ok(
    diagnostics.every(({ filename }) => files.includes(filename)),
    `${fixture.name}: unexpected diagnostic file`,
  );
  for (const file of files) {
    const actual = diagnostics.filter(({ filename }) => filename === file);
    const expected = protectedFiles.includes(file) ? fixture.expected : [];
    for (const { code, text } of expected) {
      assert.ok(
        actual.some(
          (diagnostic) =>
            diagnostic.code === code &&
            diagnostic.severity === "error" &&
            diagnostic.message.includes(text),
        ),
        `Missing ${code} ${text} for ${fixture.name} in ${file}: ${JSON.stringify(actual)}`,
      );
    }
    assert.equal(
      actual.length,
      expected.length,
      `Unexpected diagnostics for ${fixture.name} in ${file}: ${JSON.stringify(actual)}`,
    );
  }
}

try {
  const configPath = join(temporaryRoot, ".oxlintrc.json");
  copyFileSync(join(root, ".oxlintrc.json"), configPath);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFixture("benchmark/memo-barrel.ts", `export { ${aliasedNames} } from "react";`);
  for (const fixture of fixtures) {
    assertPolicy(lintFixture(configPath, fixture), fixture);
  }

  const mutationFixture = {
    name: "both restrictions",
    source: `import R, { ${apis.join(", ")} } from "react"; ${exported(`${apis.join(", ")}, ${members("R")}`)}`,
    expected: [...imports, ...properties],
  };
  assertPolicy(lintFixture(configPath, mutationFixture), mutationFixture);
  const mutations = [
    ...scopes.map(([scope, file]) => ({
      name: `remove ${scope}`,
      change: (override) => {
        override.files = override.files.filter((pattern) => pattern !== scope);
      },
      protectedFiles: restrictedFiles.filter((path) => path !== file),
      expected: mutationFixture.expected,
    })),
    ...[importRule, propertyRule].map((rule) => ({
      name: `disable ${rule}`,
      change: (override) => {
        override.rules[rule] = "off";
      },
      protectedFiles: restrictedFiles,
      expected: rule === importRule ? properties : imports,
    })),
  ];
  for (const mutation of mutations) {
    const mutated = structuredClone(config);
    const override = mutated.overrides.find(
      ({ rules }) => rules?.[importRule] && rules[propertyRule],
    );
    assert.ok(override, "The manual-memo policy override must exist");
    mutation.change(override);
    const mutatedPath = join(temporaryRoot, "mutated.oxlintrc.json");
    writeFileSync(mutatedPath, JSON.stringify(mutated));
    const diagnostics = lintFixture(mutatedPath, mutationFixture);
    assert.throws(
      () => assertPolicy(diagnostics, mutationFixture),
      { code: "ERR_ASSERTION", message: /Missing eslint\(no-restricted-/ },
      `Guard must detect mutation: ${mutation.name}`,
    );
    assertPolicy(
      diagnostics,
      { ...mutationFixture, name: mutation.name, expected: mutation.expected },
      mutation.protectedFiles,
    );
  }

  const immutabilityFixture = "benchmark/fixtures/invalid-immutability.tsx";
  mkdirSync(dirname(join(temporaryRoot, immutabilityFixture)), { recursive: true });
  copyFileSync(join(root, immutabilityFixture), join(temporaryRoot, immutabilityFixture));
  assert.ok(
    lint(configPath, [immutabilityFixture]).some(
      ({ code, severity }) => code === "react(immutability)" && severity === "error",
    ),
    "The React immutability rule must reject the fixture",
  );
  console.log(
    `Lint guard passed: ${fixtures.length} fixture cases across ${files.length} paths, ${mutations.length} policy mutations, and React immutability.`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

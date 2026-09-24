import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
writeFileSync(`${output}/.nojekyll`, "");
console.log(`Assembled ${output}/ with chooser, compiler, manual and baseline apps.`);

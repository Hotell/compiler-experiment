import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePublicArtifacts } from "./html.mjs";
import { directory, runComparison } from "./run.mjs";

export function publishComparison(outputDirectory) {
  rmSync(outputDirectory, { recursive: true, force: true });
  const report = runComparison({ outputDirectory });
  if (report.failures.length)
    throw new Error(`Compiler repro publication failed: ${report.failures.join("; ")}`);
  writePublicArtifacts(report, outputDirectory);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(directory, "../dist-pages/compiler-repros");
  publishComparison(outputDirectory);
  console.log(`Published compiler comparison: ${outputDirectory}/index.html`);
}

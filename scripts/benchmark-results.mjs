import { join } from "node:path";
import { rmSync } from "node:fs";

export const defaultResultsDirectory = "benchmark/results";

export function resultsDirectory(args = process.argv.slice(2), environment = process.env) {
  let directory = environment.BENCHMARK_RESULTS_DIR ?? defaultResultsDirectory;
  const option = args.findIndex(
    (arg) => arg === "--results-dir" || arg.startsWith("--results-dir="),
  );
  if (option !== -1) {
    const argument = args[option];
    directory =
      argument === "--results-dir" ? args[option + 1] : argument.slice("--results-dir=".length);
    if (
      args
        .slice(option + (argument === "--results-dir" ? 2 : 1))
        .some((arg) => arg === "--results-dir" || arg.startsWith("--results-dir="))
    )
      throw new Error("Specify --results-dir only once");
  }
  if (!directory || directory.startsWith("--"))
    throw new Error("Results directory must be a non-empty path");
  return directory;
}

export function rowMemoDirectory(directory = resultsDirectory()) {
  return join(directory, "row-memo");
}

export function invalidateProvenance(directory) {
  rmSync(join(directory, "provenance.json"), { force: true });
}

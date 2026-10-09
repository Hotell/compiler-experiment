# Protocol, validation and evidence scope

[Summary](README.md) | [Measurements](measurements.md) | [Stability](stability.md)

## Recorded environment

| Item                             | Value                          |
| -------------------------------- | ------------------------------ |
| Host OS                          | macOS, shared development host |
| Node                             | 22.18.0                        |
| Chromium                         | 145.0.7632.6                   |
| Playwright                       | 1.58.2                         |
| React / React DOM                | 19.3.0                         |
| Vite                             | 8.3.0                          |
| Oxc React compiler               | 0.145.0, `infer`               |
| Lighthouse                       | 12.8.2                         |
| Production timing throttle       | CDP 4x CPU                     |
| Production timing viewport       | 1440 x 900                     |
| Native timer resolution observed | Approximately 0.1 ms           |

Dependency/compiler versions were fixed during the candidate experiments.
The encoded environment identity did not capture continuous thermal, host-load
or CPU-frequency state; equal identities are not proof of equal host conditions.

## Four primary endpoints per arm

- **Load:** from navigation until all 200 rows exist and two animation frames elapse.
  Six fresh-context runs use all six arm permutations, twice per order position.
- **Selection DOM:** native target-click listener to semantic detail-DOM completion,
  on the 67-row Platform queue. One untimed open/close precedes twenty measured cycles.
- **AP DOM:** native input event to the exact ordered 34-result DOM after typing A then P.
- **Clear DOM:** native input event to the exact ordered 200-result DOM after API is cleared.
  One full filtering warm-up precedes twenty measured cycles.

Selection/filtering rotate the three arm orders over twenty cycles; this is
near-balanced, not perfectly balanced. Pages remain alive across a workload's cycles.
The twenty cycles are **not twenty independent browser-session experiments**.

Typed A retains 200 IDs and API retains the same 34 IDs as AP, so their result-DOM
timings are `null`, not zero. Their frame-opportunity timings remain secondary evidence.
The filtering protocol uses at least 100 ms between typed keys.

Semantic observers/checks are part of these timers. Filtering validates ID/text arrays
before DOM completion and performs further validation before the second-rAF timestamp.
No app-only cost was derived by subtracting hypothetical validation overhead.

## Acceptance and retention

- Each arm compares to its own reference, never to another arm's timing.
- Stage one: repeatable candidate median <= 80% of reference across all twelve gates.
- Stretch: <= 50%, separately reported.
- Raw unrounded values determine gates; rounded report cells do not.
- Missing, malformed, incompatible, zero-denominator or below-resolution evidence
  cannot become a passing percentage.
- Recheck >10% adverse latency/load/frame/retained-heap/gzip signals before retention.
  Median and p90 observations remain distinct.
- Keep cross-arm comparisons descriptive and separate from before/after reductions.
- Do not sum overlapping profiler durations or equate lower render counts with faster UI.

## Presentation and instrumentation validation

Checks included exact ordered filtering IDs, row keys/lifetimes and 166 clear remounts;
all eight profiling workflow actions; completed-root and no-op windows;
normal-build absence of recorder/Scan/DevTools instrumentation; actual Oxc transform
policy; and manual row-memo ON/OFF build identity.

Desktop/mobile workspace flows covered selection/focus trapping/restoration, dialogs,
settings validation/cancel/save, favorites/empty states, operations/notification navigation,
activity/status updates and reload resets. Additive presentation diagnostics compared
geometry to the archived reference with a fixed 1/64px tolerance, preserving existing
overflow rather than assuming the reference had none.

The ownership candidate passed 120 focused tests, 42 table presentation pairs, six
ownership pairs with 40 states per side, and 17 selected original browser tests.
The corrected reference completed the equivalent full benchmark/ablation stages,
all 19 main browser cases, three repeat-session blocks, report tests and Pages checks.
Read-only RCA was advisory compiler acceptance evidence, not an optimization ranking.

Whole-tree formatting encountered an unrelated untracked planning document. It was
left untouched; the captures used scoped authored-input format checks and documented
that exception. No correctness/readiness check was weakened to pass.

## Metadata generations

The original schema-v2 provenance incorrectly described selection warm-ups as zero.
The actual frozen workload already executed one untimed open/close. Correcting the
description to one did **not** change a timer, workload or application.

Because the provenance helper participates in protocol identity, the correction
produced a new generation. Original archives were not rewritten or normalized.
Comparators correctly rejected old/new protocol identity mismatches.
The later reference had the same application and encoded environment identities.

Exact application/protocol/environment/experiment IDs, changed-source hashes and input
hashes are retained in [evidence.json](evidence.json). These identities describe the
temporary harness used for the experiment, not the docs-only repository state.

## What the repository evidence contains

The portable extract preserves twelve timing invocations:

1. Original full reference.
2. Filtering candidate full run.
3. Ownership blocks 02/03/04, both reference and candidate.
4. Corrected-metadata full reference plus sessions 01/02/03.

For each, it contains unrounded primary and secondary frame-opportunity samples,
actual arm orders, computed median/nearest-rank p90/min/max and SHA-256 of the original
three raw timing files. Full-run files were checked against their recorded provenance;
corrected reference files were also checked against the sealed archive inventory.
Subset ownership files are extracts, not fabricated complete benchmark provenance.

SHA-256 pins identify original input bytes; they are not a substitute for distributing
those complete files. The extract permits independent recomputation of timing findings,
but not revalidation of omitted heap/Lighthouse/CPU-profile or screenshot evidence.
It deliberately omits local absolute paths, account names, process records and credentials.

## What remains external

The original and corrected reference archives, rejected candidate sources/builds, raw
traces/screenshots, CPU profiles, full Lighthouse/heap data and diagnostic command logs
remain external, immutable evidence. Selected document conclusions are archived here;
the repository is not a complete artifact mirror.

The temporary comparator, iteration-path/provenance changes, diagnostic runners, CI
edits and metadata fix were discarded for this documentation-only PR. Commands referring
to those temporary helpers are not presented as runnable current repository commands.
To reproduce, start from the application commit above, apply a historical candidate,
use the existing benchmark, and establish fresh compatible reference/candidate captures.
Historical host-dependent numbers are not CI thresholds.

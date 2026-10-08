# Production profiling overhead: historical summary

Measured on 2026-10-07, in two independent local Chromium sessions. These results compare normal production with the profiling-enabled React runtime, one root `<Profiler>`, and a stable no-op callback. React Scan, nested active boundaries, the validating recorder and React DevTools were excluded. Telemetry collection, buffering and upload costs were not measured.

## Percentage deltas versus normal production

| Metric                   |        Baseline | Manual memoization |  React Compiler |
| ------------------------ | --------------: | -----------------: | --------------: |
| Initial assets, gzip     |           +6.8% |              +6.8% |           +6.5% |
| Load readiness, 1x CPU   |  +6.5 to +10.6% |      +4.2 to +5.9% |   +7.8 to +8.2% |
| Clear-query DOM, 1x CPU  | +34.9 to +37.9% |    +31.6 to +31.7% | +29.6 to +31.1% |
| Clear-query DOM, 4x CPU  | +32.2 to +33.2% |    +35.2 to +36.2% | +33.5 to +36.9% |
| Retained JS heap, 1x CPU |          +14.8% |             +14.5% |          +13.0% |

Positive values mean overhead. Ranges span the two sessions, not confidence intervals. Bundle increases were 5.3 to 5.4 kB gzip; retained JS heap increased approximately 0.47 MB. Small absolute interaction durations can produce large percentages.

## What clear-query DOM measures

The filtering workload narrows 200 incidents to 34. Clearing the query restores all 200 incidents, including 166 rows removed by the filter. The timer starts at the native input event and stops when the expected DOM state is observed. It does not measure exclusive React CPU time, layout/paint completion, INP, total browser memory or telemetry collection. It is a workload-specific responsiveness proxy, not a general production-profiler shipping-cost metric.

## Evidence

The original source/protocol/build identities and raw paired measurements are preserved in the ignored result directories `benchmark/results/final-session-01/profiler-overhead/` and `benchmark/results/final-session-02/profiler-overhead/`. Each contains `measurements.json`, `provenance.json`, `comparison.json`, the generated report and separately captured browser traces. This Markdown records the findings even when generated artifacts are not committed.

These historical numbers must not be relabeled as measurements of granular placement, CPU consumption or renderer process memory.

## Follow-up experiment

The 2026-10-08 experiment uses only Baseline, without React Compiler or manual memoization, and compares normal production, one root Profiler and the existing root-plus-granular boundary placement. Both profiling arms use the same no-op callback and no recorder or Scan. Primary outcomes are shipped assets, load readiness, renderer CPU consumption, JS/embedder heap and renderer resident memory. CPU and memory workloads are measured separately from latency and trace recordings. Root-versus-granular results require fresh measurements under the revised protocol.

## Baseline placement results: 2026-10-08

Two fresh independent sessions compare normal production, one root Profiler, and the existing 609 boundaries at initial load (root, shell, toolbar, list, detail, queues, rows and row buttons). All use the same unoptimized Baseline source. Both profiling arms use identical stable no-op callbacks, without Scan, the validating recorder or a DevTools hook.

| Metric                                  | Root vs production | Granular vs production |  Granular vs root |
| --------------------------------------- | -----------------: | ---------------------: | ----------------: |
| Initial assets, gzip                    |              +6.8% |                  +6.8% | +0.004% (3 bytes) |
| Load readiness, 1x CPU                  |      +4.7 to +4.9% |          +7.0 to +7.5% |     +2.1 to +2.7% |
| Load readiness, 4x CPU                  |      -4.1 to +6.3% |          -1.7 to +7.9% |     +1.5 to +2.5% |
| Renderer CPU during load                |    +10.3 to +18.1% |        +16.6 to +17.7% |     -0.3 to +5.7% |
| Renderer CPU during 20 warmed workflows |      +8.4 to +9.3% |         +9.8 to +11.7% |     +1.3 to +2.2% |
| Post-GC JS heap after load              |             +14.8% |                 +21.3% |             +5.7% |
| Post-GC JS heap after workflows         |    +12.1 to +12.2% |                 +15.5% |     +2.9 to +3.0% |
| Post-GC renderer RSS after load         |      +2.3 to +2.6% |          +2.7 to +2.8% |     +0.1 to +0.5% |
| Renderer RSS after workflows            |      -0.5 to +1.9% |          +1.1 to +1.5% |     -0.7 to +2.0% |

Positive means overhead against the explicitly named reference. Each range spans two sessions, not a confidence interval. The granular-versus-root percentage divides by root-only, not normal production. Report rounding can conceal small differences; comparisons use unrounded medians.

CPU is measured at 1x using CDP's cumulative renderer CPU seconds across all threads, converted to milliseconds. Each interval requires unchanged renderer process IDs. The warmed workflow opens detail, favorites/unfavorites, closes detail, types API and clears the query. It is repeated twenty times after one warm-up. CPU intervals contain no tracing, heap/RSS polling or forced GC. Renderer CPU includes browser-in-page and automation-related work, not exclusively React or whole-browser/GPU consumption.

Memory runs are separate. JS/embedder heap is sampled during load and captured before/after forced GC, then again after the workflows. RSS is resident memory summed over renderer processes at readiness and after GC/workflows; it is not private memory, a sampled peak, or the entire browser process tree. Shared resident pages and allocator/OS behavior limit interpretation. RSS snapshots use macOS `ps` or Linux `/proc/status`.

The original CPU/resource counters, six balanced three-arm orders per pass, source/build/protocol hashes and separate browser traces are stored in `benchmark/results/placement-session-01/profiler-overhead/` and `benchmark/results/placement-session-02/profiler-overhead/`. The revised schema is version 2. No archived root-only results were overwritten.

### Interpretation

Root-only has lower observed warmed-workflow CPU and retained JS heap than granular placement in both sessions. The additional granular cost is approximately 41 to 71 CPU ms over twenty workflows and 209 kB of post-load retained JS heap. Both placements still incur the profiling runtime's cost versus normal production. The extra shipped gzip bytes for placement itself are negligible in this build.

Load readiness at 4x and post-workflow RSS vary in direction against production; these data do not establish a repeatable improvement or equivalent memory use. Six repetitions and two local sessions do not establish fleet behavior, a leak verdict or a shipping budget. Real telemetry collection, serialization and upload remain unmeasured.

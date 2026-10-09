# Measurement instability

[Summary](README.md) | [Protocol](methodology.md) | [Portable samples](evidence.json)

**No additional timer malfunction or single causal explanation was established.**
Further performance acceptance was paused rather than certified from favorable runs.

## Raw-confirmed current reference variation

All four columns use unchanged application bytes. Spread is:

```text
(maximum session median - minimum session median) / pinned full median * 100
```

Values below are display-rounded. The portable samples retain the underlying numbers.

| Arm / endpoint         | Full / 01 / 02 / 03 median ms     | Spread / pin |
| ---------------------- | --------------------------------- | -----------: |
| Baseline load          | 319.15 / 307.25 / 343.90 / 318.85 |       11.48% |
| Baseline selection DOM | 5.50 / 5.95 / 6.70 / 6.70         |   **21.82%** |
| Baseline AP DOM        | 15.85 / 15.65 / 16.45 / 16.65     |        6.31% |
| Baseline clear DOM     | 21.45 / 20.90 / 22.85 / 22.40     |        9.09% |
| Manual load            | 315.60 / 306.30 / 348.45 / 333.05 |       13.36% |
| Manual selection DOM   | 2.75 / 2.75 / 3.55 / 3.35         |   **29.09%** |
| Manual AP DOM          | 13.20 / 12.50 / 13.35 / 13.55     |        7.95% |
| Manual clear DOM       | 18.90 / 19.90 / 20.80 / 22.00     |       16.40% |
| Compiler load          | 340.50 / 315.95 / 348.95 / 333.30 |        9.69% |
| Compiler selection DOM | 2.80 / 2.95 / 3.75 / 3.35         |   **33.93%** |
| Compiler AP DOM        | 12.30 / 12.70 / 13.10 / 13.25     |        7.72% |
| Compiler clear DOM     | 19.45 / 20.00 / 21.35 / 22.35     |       14.91% |

All three selection endpoints vary at a scale greater than the desired 20% effect.
The other nine staying below that observed range does **not** certify them stable.

## Within-session and order effects

Selection first-five versus last-five medians declined by up to **48%** despite the real
warm-up. In corrected session 03, manual changed 4.6 -> 2.4 ms and compiler 5.0 -> 2.6 ms.
This contradicts assuming stationary cycles but does not distinguish JIT, GC, frame
phase or external host contention.

Selection/filtering use three cyclic arm orders. Position counts over twenty cycles are
6/7/7, 7/6/7 and 7/7/6; only the first eighteen are exactly balanced. Slowest positions
changed across sessions. Position and chronology are confounded; detrending did not
identify an independent order cause. Six-load permutations were balanced.

## Timer and diagnostic limits

- Approximately 0.1ms native quantization is smaller than the target selection savings
  of 1.10 / 0.55 / 0.56ms; quantization alone does not explain the observed spread.
- `paintMs` ends at a second rAF callback. It is not actual paint, presentation or INP.
  Unchanged-result API frame timings varied substantially even on identical builds.
- Retained post-GC heap medians were nearly unchanged; sparse GC/memory samples could
  not identify a causal relationship to timing.
- Native-event-to-semantic-DOM timing excludes pre-dispatch locator/actionability work
  but includes observer registration/validation/microtask timing.
- Archived whole-window favorite CPU profiles contained substantial automation selector
  traversal; they were not used to rank app-only hotspots.
- RCA/cache-slot counts and profiler callbacks do not measure latency improvements.

## Bounded host observations

Five read-only snapshots over 123.8 seconds on October 7 showed a nonquiet host:
10 logical/physical cores, 25.86-55.22% aggregate CPU utilization, and one-minute load
of 0.70-1.35 per core. Memory pressure was normal and power remained AC.
Usable thermal/frequency counters were unavailable.

No stale benchmark-process ownership was verified. No unrelated process was terminated,
and no host setting, timer or application behavior was changed. Live snapshots cannot
prove what caused older samples; machine-specific process details are not published.

## Next-step boundary

First pause controllable unrelated workloads and independently establish a quiet window.
Then, if justified, run **one bounded confirmation of three serial sessions** using the
unchanged load/selection/filtering/load-memory workloads and the same archived builds.
Record all sessions and actual order; do not retry until a favorable sample appears.

Do not lower the target, change readiness semantics or certify performance from render counts.
Further architectural or visible presentation changes require targeted approval and new
reference/candidate evidence. The documentation preserves an unsuccessful investigation;
it does not claim optimization is impossible or that every candidate had zero effect.

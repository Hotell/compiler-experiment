# Exact tested candidates

[Summary](README.md) | [Measurements](measurements.md) | [Methodology](methodology.md)

These are historical candidate diffs. **None is retained in application source.**

## 1. Filtering and allocation cleanup

Changed [shared/incidents.ts](../../../shared/incidents.ts), which all three apps use.
The recovered candidate's file bytes match the measured archive's SHA-256:
`2a686f2eb7c0ca800ef0eefb6b82efb4d46352bd5a8f1da42386802a5815748f`.

### Exact diff

```diff
--- a/shared/incidents.ts
+++ b/shared/incidents.ts
@@ -17,8 +17,14 @@
 };

 export const queues: Queue[] = ["All incidents", "Platform", "Payments", "Identity"];
 export const statuses: Status[] = ["Open", "Investigating", "Resolved"];
+const severityRank: Record<Incident["severity"], number> = {
+  Critical: 0,
+  High: 1,
+  Medium: 2,
+  Low: 3,
+};
 const services = ["API gateway", "Checkout", "Authentication", "Worker pool", "Billing", "Search"];
 const issues = [
   "Elevated error rate",
   "Latency above threshold",
@@ -58,20 +64,34 @@
   sort: string,
   favoritesOnly = false,
 ) {
   const query = search.trim().toLowerCase();
-  const filtered = incidents.filter(
-    (incident) =>
-      (queue === "All incidents" || incident.queue === queue) &&
-      (status === "All statuses" || incident.status === status) &&
-      (!favoritesOnly || incident.favorite) &&
-      (!query ||
-        `${incident.id} ${incident.title} ${incident.service}`.toLowerCase().includes(query)),
-  );
+  const spansFields = query.includes(" ");
+  const filtered: Incident[] = [];
+  for (const incident of incidents) {
+    if (
+      (queue !== "All incidents" && incident.queue !== queue) ||
+      (status !== "All statuses" && incident.status !== status) ||
+      (favoritesOnly && !incident.favorite)
+    )
+      continue;
+    if (query) {
+      const matchesField =
+        incident.id.toLowerCase().includes(query) ||
+        incident.title.toLowerCase().includes(query) ||
+        incident.service.toLowerCase().includes(query);
+      if (
+        !matchesField &&
+        (!spansFields ||
+          !`${incident.id} ${incident.title} ${incident.service}`.toLowerCase().includes(query))
+      )
+        continue;
+    }
+    filtered.push(incident);
+  }
   if (sort === "severity") {
-    const order = ["Critical", "High", "Medium", "Low"];
     return filtered.sort(
-      (left, right) => order.indexOf(left.severity) - order.indexOf(right.severity),
+      (left, right) => severityRank[left.severity] - severityRank[right.severity],
     );
   }
   return sort === "oldest" ? filtered.reverse() : filtered;
 }
```

### Intended behavior and causal hypothesis

- Early loop exclusions replace filter callbacks without changing eligibility.
- Independent ID/title/service checks can short-circuit before building a combined string.
- Unmatched queries containing a literal space still search the combined string,
  preserving cross-field searches.
- A fixed rank lookup replaces per-comparison severity `indexOf`; no search index or
  result cache is added.

Case/whitespace, cross-field matching, combined filters, stable sort ties, immutable updates
and ordered query-transition IDs passed focused fixtures. Manual's `useMemo` was unchanged.

One complete candidate benchmark passed all 19 browser tests. AP timing was mixed:
baseline 3.87% faster, manual unchanged, compiler 4.60% slower. Small clear-query differences
were not established as repeatable. The helper and candidate-only test were removed.

## 2. Explicit row-button intrinsic width

Changed [shared/styles.css](../../../shared/styles.css), shared by all arms:

```diff
 .row-open {
   align-content: center;
+  width: max-content;
   min-width: 190px;
   max-width: 270px;
 }
```

The low-confidence hypothesis was to reduce intrinsic grid/shrink-to-fit sizing during
automatic table layout. This did not fix columns or reduce DOM work.
The trace had not isolated this particular CSS path as the dominant cost.

All ordered/accessibility and row-lifetime checks passed; **338/342** strict state
snapshots matched. Remaining differences included a few pixels in an unchanged toolbar
star and unresolved whole-snapshot geometry hashes. Rechecks passed but did not explain
the failed full sweep.

This was **inconclusive presentation equivalence**, not a proven repeatable visible
regression or a performance regression. The rule was reverted **before acceptance timing**.

## 3. Table layout containment

This was a browser-injected preflight against already-ready archived builds,
**not a built application-source patch**. The entire injected rule was:

```css
.table-scroll {
  contain: layout;
}
```

The hypothesis was to restrict layout invalidation within the existing scroll container.
No size/paint containment, `content-visibility`, virtualization or deferred work was used.

Layout containment established a new containing block for the absolutely positioned,
screen-reader-only Favorite header. Its accessible text and captured rectangle remained
the same, but overflow ownership changed. At a 701px viewport:

| State         | Original document width | Contained width |
| ------------- | ----------------------: | --------------: |
| All 200 rows  |                   883px |           701px |
| AP results    |                   878px |           701px |
| Empty results |                   894px |           701px |

**36/72** strict state comparisons failed, across all six builds and both densities at
701px. All 72 removals restored reference snapshots. The equivalent-presentation contract
rejected this change, even though reducing overflow could otherwise be desirable.

No latency was measured. Injecting a rule after readiness is a semantic probe, not
evidence of load performance. No compensating markup or UX change was attempted.

## 4. Narrower filtering/render ownership

Changed [shared/App.tsx](../../../shared/App.tsx) and
[apps/manual/src/App.tsx](../../../apps/manual/src/App.tsx).

### Exact shared-source diff

```diff
--- a/shared/App.tsx
+++ b/shared/App.tsx
@@ -548,27 +548,32 @@
       )}
     </dialog>
   );
 }
-function Shell() {
+function IncidentContent() {
   const { incidents } = useIncidents();
   const { queue } = useWorkspace();
   const { search, status, sort, favoritesOnly } = useFilters();
-  const { settings } = useUserSettings();
   const visible = visibleIncidents(incidents, queue, search, status, sort, favoritesOnly);
   return (
+    <main className="main">
+      <Profiled id="toolbar">
+        <Toolbar incidents={visible} />
+      </Profiled>
+      <Profiled id="list">
+        <IncidentList incidents={visible} />
+      </Profiled>
+    </main>
+  );
+}
+function Shell() {
+  const { settings } = useUserSettings();
+  return (
     <div className="app" data-density={settings.density}>
       <Header />
       <div className="workspace">
         <Sidebar />
-        <main className="main">
-          <Profiled id="toolbar">
-            <Toolbar incidents={visible} />
-          </Profiled>
-          <Profiled id="list">
-            <IncidentList incidents={visible} />
-          </Profiled>
-        </main>
+        <IncidentContent />
         <Profiled id="detail">
           <Detail />
         </Profiled>
       </div>
```

### Exact manual-source diff

```diff
--- a/apps/manual/src/App.tsx
+++ b/apps/manual/src/App.tsx
@@ -569,30 +569,35 @@
       )}
     </dialog>
   );
 });
-function Shell() {
+function IncidentContent() {
   const { incidents } = useIncidents();
   const { queue } = useWorkspace();
   const { search, status, sort, favoritesOnly } = useFilters();
-  const { settings } = useUserSettings();
   const visible = useMemo(
     () => visibleIncidents(incidents, queue, search, status, sort, favoritesOnly),
     [incidents, queue, search, status, sort, favoritesOnly],
   );
   return (
+    <main className="main">
+      <Profiled id="toolbar">
+        <Toolbar incidents={visible} />
+      </Profiled>
+      <Profiled id="list">
+        <IncidentList incidents={visible} />
+      </Profiled>
+    </main>
+  );
+}
+function Shell() {
+  const { settings } = useUserSettings();
+  return (
     <div className="app" data-density={settings.density}>
       <Header />
       <div className="workspace">
         <Sidebar />
-        <main className="main">
-          <Profiled id="toolbar">
-            <Toolbar incidents={visible} />
-          </Profiled>
-          <Profiled id="list">
-            <IncidentList incidents={visible} />
-          </Profiled>
-        </main>
+        <IncidentContent />
         <Profiled id="detail">
           <Detail />
         </Profiled>
       </div>
```

### Actual behavior and limits

Previously, `Shell` subscribed to incidents, queue, filters and settings. The candidate
left only settings in `Shell`; `IncidentContent` owned the unchanged derivation and
incident/queue/filter subscriptions. Context updates could reach the smaller owner
without re-executing the broad shell.

The extraction added one ordinary React component fiber, but no DOM element or provider.
The existing main/toolbar/list/detail profiler boundaries, measured children and keys
were preserved. Components with direct matching context subscriptions still updated.

**Selection logic did not change:** selection subscriptions remained in `IncidentList`
and `Detail`. No new memo boundaries were introduced. Manual's original `useMemo` and
six dependencies moved intact. Baseline stayed memo-free; compiler stayed Oxc `infer`.

All 42 presentation comparisons, six ownership pairs with 40 states per side, and all
17 selected original browser tests passed. Filtering detail profiler callbacks changed
`1 -> 0` and queue callbacks `4 -> 0` in baseline/manual; baseline queue-body renders
also changed `4 -> 0`. Selection row body counts stayed `67 / 1 / 67` for
baseline/manual/compiler. These are strategy observations, not latency gates.

Three paired sessions showed baseline clear-DOM savings of 13.74-15.89%, but no
repeatably established 20% gates and adverse frame-opportunity guardrail signals.
The [measurement record](measurements.md) includes every primary endpoint and the
host/reference drift. Both application edits were removed.

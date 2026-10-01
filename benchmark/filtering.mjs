const initialIds = Array.from(
  { length: 200 },
  (_, index) => `INC-${String(index + 1).padStart(4, "0")}`,
);

export const filteringProtocol = {
  query: "API",
  viewport: { width: 1440, height: 900 },
  minimumKeyDelayMs: 100,
  warmups: 1,
  initialState: {
    queue: "All incidents",
    status: "All statuses",
    sort: "newest",
    search: "",
    rows: 200,
    detailIncludes: "No incident selected",
  },
  initialIds,
  filteredIds: initialIds.filter((_, index) => index % 6 === 0),
  steps: [
    { name: "type A", query: "A", rows: 200, resultsChanged: false },
    { name: "type AP", query: "AP", rows: 34, resultsChanged: true },
    { name: "type API", query: "API", rows: 34, resultsChanged: false },
    { name: "clear query", query: "", rows: 200, resultsChanged: true },
  ],
};

export function filteringResultIds(query) {
  return query.length > 1 ? filteringProtocol.filteredIds : filteringProtocol.initialIds;
}

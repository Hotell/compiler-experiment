import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { initialIncidents, type Incident, type Queue } from "../../../shared/incidents";

type WorkspaceValue = { queue: Queue; setQueue: (queue: Queue) => void };
type IncidentValue = {
  incidents: Incident[];
  toggleFavorite: (id: string) => void;
  resolve: (id: string) => void;
};
type FilterValue = {
  search: string;
  setSearch: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  sort: string;
  setSort: (value: string) => void;
};
type SelectionValue = { selectedId: string | null; setSelectedId: (id: string | null) => void };
type ReviewValue = { reviews: number; addReview: () => void };

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
const IncidentContext = createContext<IncidentValue | null>(null);
const IncidentActionsContext = createContext<Pick<
  IncidentValue,
  "toggleFavorite" | "resolve"
> | null>(null);
const FilterContext = createContext<FilterValue | null>(null);
const SelectionContext = createContext<SelectionValue | null>(null);
const SelectionActionsContext = createContext<Pick<SelectionValue, "setSelectedId"> | null>(null);
const ReviewContext = createContext<ReviewValue | null>(null);

function useRequired<T>(value: T | null): T {
  if (!value) throw new Error("Missing incident workspace provider");
  return value;
}
export const useWorkspace = () => useRequired(useContext(WorkspaceContext));
export const useIncidents = () => useRequired(useContext(IncidentContext));
export const useIncidentActions = () => useRequired(useContext(IncidentActionsContext));
export const useFilters = () => useRequired(useContext(FilterContext));
export const useSelection = () => useRequired(useContext(SelectionContext));
export const useSelectionActions = () => useRequired(useContext(SelectionActionsContext));
export const useReviews = () => useRequired(useContext(ReviewContext));

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Queue>("All incidents");
  const value = useMemo(() => ({ queue, setQueue }), [queue]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
export function IncidentProvider({ children }: { children: ReactNode }) {
  const [incidents, setIncidents] = useState(initialIncidents);
  const toggleFavorite = useCallback(
    (id: string) =>
      setIncidents((current) =>
        current.map((incident) =>
          incident.id === id
            ? {
                ...incident,
                favorite: !incident.favorite,
                activity: [...incident.activity, "Favorite changed"],
              }
            : incident,
        ),
      ),
    [],
  );
  const resolve = useCallback(
    (id: string) =>
      setIncidents((current) =>
        current.map((incident) =>
          incident.id === id
            ? {
                ...incident,
                status: "Resolved",
                activity: [...incident.activity, "Incident resolved"],
              }
            : incident,
        ),
      ),
    [],
  );
  const value = useMemo(
    () => ({ incidents, toggleFavorite, resolve }),
    [incidents, toggleFavorite, resolve],
  );
  const actions = useMemo(() => ({ toggleFavorite, resolve }), [toggleFavorite, resolve]);
  return (
    <IncidentActionsContext value={actions}>
      <IncidentContext value={value}>{children}</IncidentContext>
    </IncidentActionsContext>
  );
}
export function FilterProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [sort, setSort] = useState("newest");
  const value = useMemo(
    () => ({ search, setSearch, status, setStatus, sort, setSort }),
    [search, status, sort],
  );
  return <FilterContext value={value}>{children}</FilterContext>;
}
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const value = useMemo(() => ({ selectedId, setSelectedId }), [selectedId]);
  const actions = useMemo(() => ({ setSelectedId }), []);
  return (
    <SelectionActionsContext value={actions}>
      <SelectionContext value={value}>{children}</SelectionContext>
    </SelectionActionsContext>
  );
}
export function ReviewProvider({ children }: { children: ReactNode }) {
  const [reviews, setReviews] = useState(0);
  const addReview = useCallback(() => setReviews((value) => value + 1), []);
  const value = useMemo(() => ({ reviews, addReview }), [reviews, addReview]);
  return <ReviewContext value={value}>{children}</ReviewContext>;
}

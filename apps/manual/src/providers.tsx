import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  initialIncidents,
  initialNotifications,
  initialSettings,
  type Incident,
  type Notification,
  type Queue,
  type UserSettings,
} from "../../../shared/incidents";

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
  favoritesOnly: boolean;
  setFavoritesOnly: (value: boolean) => void;
};
type SelectionValue = { selectedId: string | null; setSelectedId: (id: string | null) => void };
type NotificationValue = {
  notifications: Notification[];
  markRead: (incidentId: string) => void;
  markAllRead: () => void;
};
type SettingsValue = { settings: UserSettings; saveSettings: (settings: UserSettings) => void };

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
const IncidentContext = createContext<IncidentValue | null>(null);
const IncidentActionsContext = createContext<Pick<
  IncidentValue,
  "toggleFavorite" | "resolve"
> | null>(null);
const FilterContext = createContext<FilterValue | null>(null);
const SelectionContext = createContext<SelectionValue | null>(null);
const SelectionActionsContext = createContext<Pick<SelectionValue, "setSelectedId"> | null>(null);
const NotificationContext = createContext<NotificationValue | null>(null);
const SettingsContext = createContext<SettingsValue | null>(null);

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
export const useNotifications = () => useRequired(useContext(NotificationContext));
export const useUserSettings = () => useRequired(useContext(SettingsContext));

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
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const value = useMemo(
    () => ({
      search,
      setSearch,
      status,
      setStatus,
      sort,
      setSort,
      favoritesOnly,
      setFavoritesOnly,
    }),
    [search, status, sort, favoritesOnly],
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
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const markRead = useCallback(
    (incidentId: string) =>
      setNotifications((current) =>
        current.map((item) => (item.incidentId === incidentId ? { ...item, read: true } : item)),
      ),
    [],
  );
  const markAllRead = useCallback(
    () => setNotifications((current) => current.map((item) => ({ ...item, read: true }))),
    [],
  );
  const value = useMemo(
    () => ({ notifications, markRead, markAllRead }),
    [notifications, markRead, markAllRead],
  );
  return <NotificationContext value={value}>{children}</NotificationContext>;
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, saveSettings] = useState(initialSettings);
  const value = useMemo(() => ({ settings, saveSettings }), [settings]);
  return <SettingsContext value={value}>{children}</SettingsContext>;
}

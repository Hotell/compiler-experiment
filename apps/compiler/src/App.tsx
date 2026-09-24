import { Profiler, useEffect, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  ArrowDownUp,
  Bell,
  Check,
  ChevronLeft,
  CircleAlert,
  Clock3,
  Search,
  Star,
} from "lucide-react";
import { queues, statuses, visibleIncidents, type Incident } from "../../../shared/incidents";
import { onRender } from "../../../benchmark/recorder";
import {
  FilterProvider,
  IncidentProvider,
  ReviewProvider,
  SelectionProvider,
  WorkspaceProvider,
  useFilters,
  useIncidentActions,
  useIncidents,
  useReviews,
  useSelection,
  useSelectionActions,
  useWorkspace,
} from "./providers";

function Profiled({ id, children }: { id: string; children: ReactNode }) {
  return import.meta.env.MODE === "profile" ? (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  ) : (
    children
  );
}

function Header() {
  const { reviews, addReview } = useReviews();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Activity size={19} />
        </span>
        <span>
          signal<span className="brand-dot">.</span>
        </span>
        <span className="brand-sub">/ incident operations</span>
      </div>
      <div className="header-actions">
        <span className="environment">
          <span className="live-dot" /> Production
        </span>
        <button className="review-button" onClick={addReview} aria-label="Add review">
          <Bell size={16} /> Reviews <strong data-testid="reviews">{reviews}</strong>
        </button>
        <span className="avatar" aria-label="Signed in as Alex Chen">
          AC
        </span>
      </div>
    </header>
  );
}
function Sidebar() {
  const { queue, setQueue } = useWorkspace();
  return (
    <aside className="sidebar">
      <div className="section-label">
        WORKSPACE <span>01 / 04</span>
      </div>
      <div className="sidebar-heading">Queues</div>
      <nav aria-label="Incident queues">
        {queues.map((item, index) => (
          <button
            key={item}
            className={`queue-item ${queue === item ? "active" : ""}`}
            onClick={() => setQueue(item)}
            aria-current={queue === item ? "page" : undefined}
          >
            <span className="queue-glyph">
              {index === 0 ? <Activity size={16} /> : <span className="queue-square" />}
            </span>
            {item}
            <span className="queue-count">
              {index === 0 ? "200" : index === 1 ? "67" : index === 2 ? "67" : "66"}
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-footer-icon">
          <CircleAlert size={17} />
        </div>
        <div>
          <strong>Operations desk</strong>
          <small>Monitoring all systems</small>
        </div>
        <span className="live-dot" />
      </div>
    </aside>
  );
}
function Toolbar({ incidents }: { incidents: Incident[] }) {
  const { search, setSearch, status, setStatus, sort, setSort } = useFilters();
  const count = incidents.length;
  const statusCounts = statuses.map(
    (item) => incidents.filter((incident) => incident.status === item).length,
  );
  return (
    <>
      <div className="content-heading">
        <div>
          <div className="eyebrow">OPERATIONS / INCIDENTS</div>
          <h1>Incident triage</h1>
          <p>Monitor, investigate, and resolve service disruptions.</p>
        </div>
        <div className="date-stamp">
          <Clock3 size={15} /> Live workspace
        </div>
      </div>
      <div className="summary">
        <div>
          <span className="summary-icon orange">
            <CircleAlert size={17} />
          </span>
          <span>
            <small>TOTAL INCIDENTS</small>
            <strong data-testid="total">{count}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon red">
            <Activity size={17} />
          </span>
          <span>
            <small>OPEN</small>
            <strong data-testid="open-count">{statusCounts[0]}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon blue">
            <Clock3 size={17} />
          </span>
          <span>
            <small>INVESTIGATING</small>
            <strong>{statusCounts[1]}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon green">
            <Check size={17} />
          </span>
          <span>
            <small>RESOLVED</small>
            <strong>{statusCounts[2]}</strong>
          </span>
        </div>
      </div>
      <div className="list-top">
        <div>
          <h2>
            Incidents <span>{count}</span>
          </h2>
          <p>Manage and track your active incidents</p>
        </div>
        <div className="filters">
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="Search incidents"
              placeholder="Search incidents..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="select-field">
            <span className="sr-only">Status</span>
            <select
              aria-label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option>All statuses</option>
              {statuses.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="select-field sort-field">
            <ArrowDownUp size={15} />
            <span className="sr-only">Sort</span>
            <select
              aria-label="Sort"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="severity">Severity</option>
            </select>
          </label>
        </div>
      </div>
    </>
  );
}
function OpenIncidentButton({
  id,
  title,
  severity,
  onOpen,
}: {
  id: string;
  title: string;
  severity: Incident["severity"];
  onOpen: () => void;
}) {
  return (
    <Profiled id={`button:open:${id}`}>
      <button className="row-open" onClick={onOpen} aria-label={`Open ${id}`}>
        <span className={`severity-mark ${severity.toLowerCase()}`} />
        <span className="incident-title">{title}</span>
        <span className="incident-id">{id}</span>
      </button>
    </Profiled>
  );
}
function FavoriteButton({
  id,
  favorite,
  onToggle,
}: {
  id: string;
  favorite: boolean;
  onToggle: () => void;
}) {
  return (
    <Profiled id={`button:favorite:${id}`}>
      <button
        className={`favorite ${favorite ? "is-favorite" : ""}`}
        aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${id}`}
        aria-pressed={favorite}
        onClick={onToggle}
      >
        <Star size={16} fill={favorite ? "currentColor" : "none"} />
      </button>
    </Profiled>
  );
}
function IncidentRow({ incident, selected }: { incident: Incident; selected: boolean }) {
  const { setSelectedId } = useSelectionActions();
  const { toggleFavorite } = useIncidentActions();
  const openIncident = () => setSelectedId(incident.id);
  const toggleIncidentFavorite = () => toggleFavorite(incident.id);
  return (
    <Profiled id={`row:${incident.id}`}>
      <tr className={selected ? "selected" : ""}>
        <td>
          <OpenIncidentButton
            id={incident.id}
            title={incident.title}
            severity={incident.severity}
            onOpen={openIncident}
          />
        </td>
        <td className="service-cell">{incident.service}</td>
        <td>
          <span className={`status-badge ${incident.status.toLowerCase()}`}>
            <span />
            {incident.status}
          </span>
        </td>
        <td>
          <span className={`severity-label ${incident.severity.toLowerCase()}`}>
            {incident.severity}
          </span>
        </td>
        <td className="owner-cell">{incident.owner}</td>
        <td className="time-cell">{incident.time}</td>
        <td>
          <FavoriteButton
            id={incident.id}
            favorite={incident.favorite}
            onToggle={toggleIncidentFavorite}
          />
        </td>
      </tr>
    </Profiled>
  );
}
function IncidentList({ incidents }: { incidents: Incident[] }) {
  const { selectedId } = useSelection();
  return (
    <Profiled id="list">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>INCIDENT</th>
              <th>SERVICE</th>
              <th>STATUS</th>
              <th>SEVERITY</th>
              <th>OWNER</th>
              <th>TIME</th>
              <th>
                <span className="sr-only">Favorite</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                selected={selectedId === incident.id}
              />
            ))}
          </tbody>
        </table>
        {incidents.length === 0 && <div className="empty">No incidents match your filters.</div>}
      </div>
    </Profiled>
  );
}
function Detail() {
  const { selectedId, setSelectedId } = useSelection();
  const { incidents, resolve, toggleFavorite } = useIncidents();
  const incident = incidents.find((item) => item.id === selectedId);
  useEffect(() => {
    if (selectedId && window.matchMedia("(max-width: 1050px)").matches)
      document.querySelector<HTMLButtonElement>(".detail .back-button")?.focus();
  }, [selectedId]);
  function closeDetail() {
    setSelectedId(null);
    document.querySelector<HTMLButtonElement>(`[aria-label="Open ${selectedId}"]`)?.focus();
  }
  function onDetailKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") closeDetail();
    if (event.key !== "Tab" || !window.matchMedia("(max-width: 1050px)").matches) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (event.shiftKey && document.activeElement === buttons[0]) {
      event.preventDefault();
      buttons.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
      event.preventDefault();
      buttons[0]?.focus();
    }
  }
  return (
    <Profiled id="detail">
      <dialog
        open
        className={`detail ${incident ? "detail-open" : ""}`}
        aria-modal={incident && window.matchMedia("(max-width: 1050px)").matches ? true : undefined}
        onKeyDown={onDetailKeyDown}
        aria-label="Incident detail"
      >
        {incident ? (
          <>
            <div className="detail-head">
              <button className="back-button" onClick={closeDetail} aria-label="Close detail">
                <ChevronLeft size={18} />
              </button>
              <span>INCIDENT DETAILS</span>
              <button
                className={`favorite ${incident.favorite ? "is-favorite" : ""}`}
                aria-label={`${incident.favorite ? "Unfavorite" : "Favorite"} detail`}
                onClick={() => toggleFavorite(incident.id)}
              >
                <Star size={17} fill={incident.favorite ? "currentColor" : "none"} />
              </button>
            </div>
            <div className="detail-body">
              <span className="detail-id">{incident.id}</span>
              <h2>{incident.title}</h2>
              <span className={`status-badge ${incident.status.toLowerCase()}`}>
                <span />
                {incident.status}
              </span>
              <div className="detail-section">
                <h3>Overview</h3>
                <dl>
                  <div>
                    <dt>Service</dt>
                    <dd>{incident.service}</dd>
                  </div>
                  <div>
                    <dt>Queue</dt>
                    <dd>{incident.queue}</dd>
                  </div>
                  <div>
                    <dt>Severity</dt>
                    <dd>{incident.severity}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{incident.owner}</dd>
                  </div>
                  <div>
                    <dt>Detected</dt>
                    <dd>Today, {incident.time}</dd>
                  </div>
                </dl>
              </div>
              <div className="detail-section">
                <h3>Activity</h3>
                <ul className="activity-list">
                  {incident.activity.map((entry, index) => (
                    <li key={index}>
                      {entry}
                      <small>Today</small>
                    </li>
                  ))}
                </ul>
              </div>
              {incident.status !== "Resolved" && (
                <button className="resolve-button" onClick={() => resolve(incident.id)}>
                  <Check size={16} /> Mark resolved
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="detail-placeholder">
            <span className="placeholder-icon">
              <Activity size={24} />
            </span>
            <h2>No incident selected</h2>
            <p>Select an incident from the list to view its details and activity.</p>
          </div>
        )}
      </dialog>
    </Profiled>
  );
}
function Shell() {
  const { incidents } = useIncidents();
  const { queue } = useWorkspace();
  const { search, status, sort } = useFilters();
  const visible = visibleIncidents(incidents, queue, search, status, sort);
  return (
    <Profiled id="shell">
      <div className="app">
        <Header />
        <div className="workspace">
          <Sidebar />
          <main className="main">
            <Toolbar incidents={visible} />
            <IncidentList incidents={visible} />
          </main>
          <Detail />
        </div>
      </div>
    </Profiled>
  );
}
export default function App() {
  return (
    <WorkspaceProvider>
      <IncidentProvider>
        <FilterProvider>
          <SelectionProvider>
            <ReviewProvider>
              <Shell />
            </ReviewProvider>
          </SelectionProvider>
        </FilterProvider>
      </IncidentProvider>
    </WorkspaceProvider>
  );
}

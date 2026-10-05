import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, StatusBadge, TextInput } from "./controls";
import {
  queues,
  type Incident,
  type Notification,
  type Queue,
  type UserSettings,
} from "./incidents";

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) throw new Error("Missing workspace dialog");
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="workspace-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="workspace-dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <Button
          type="button"
          className="dialog-close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <X size={20} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function NotificationsDialog({
  notifications,
  incidents,
  onRead,
  onReadAll,
  onOpen,
  onClose,
}: {
  notifications: Notification[];
  incidents: Incident[];
  onRead: (id: string) => void;
  onReadAll: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const unread = notifications.filter((item) => !item.read).length;
  return (
    <Modal title="Notifications" onClose={onClose}>
      <div className="dialog-toolbar">
        <output>{unread ? `${unread} unread alerts` : "You're all caught up."}</output>
        <Button className="secondary-button" disabled={unread === 0} onClick={onReadAll}>
          Mark all as read
        </Button>
      </div>
      <ul className="notification-list">
        {notifications.map((item) => {
          const incident = incidents.find((value) => value.id === item.incidentId);
          if (!incident)
            throw new Error(`Notification references missing incident ${item.incidentId}`);
          return (
            <li key={item.incidentId} className={item.read ? "is-read" : "is-unread"}>
              <div className="notification-meta">
                <span>
                  {item.read ? "Read" : "Unread"} · {incident.id}
                </span>
                <StatusBadge status={incident.status} />
              </div>
              <h3>{incident.title}</h3>
              <p>
                Critical alert · {incident.queue} · Today, {incident.time}
              </p>
              <div className="dialog-actions">
                <Button className="secondary-button" onClick={() => onOpen(incident.id)}>
                  View {incident.id}
                </Button>
                {!item.read && (
                  <Button
                    className="text-button"
                    aria-label={`Mark ${incident.id} as read`}
                    onClick={() => onRead(incident.id)}
                  >
                    Mark as read
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="dialog-note">
        Alerts come from this demo's initial incidents. Changes stay in this tab until reload.
      </p>
    </Modal>
  );
}

export function ProfileDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: UserSettings;
  onSave: (settings: UserSettings) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(settings.displayName);
  const [density, setDensity] = useState(settings.density);
  const nameId = useId();
  return (
    <Modal title="Profile settings" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ displayName: name.trim(), density });
          onClose();
        }}
      >
        <label className="settings-name" htmlFor={nameId}>
          Display name
          <TextInput
            id={nameId}
            required
            maxLength={40}
            pattern={".*\\S.*"}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="density-options">
          <legend>Table density</legend>
          <label>
            <TextInput
              type="radio"
              name="density"
              checked={density === "comfortable"}
              onChange={() => setDensity("comfortable")}
            />{" "}
            Comfortable
          </label>
          <label>
            <TextInput
              type="radio"
              name="density"
              checked={density === "compact"}
              onChange={() => setDensity("compact")}
            />{" "}
            Compact
          </label>
        </fieldset>
        <p className="dialog-note">
          These preferences apply to this session only. Reload restores the demo defaults.
        </p>
        <div className="dialog-actions">
          <Button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="primary-button">
            Save settings
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function OperationsDialog({
  incidents,
  onNavigate,
  onClose,
}: {
  incidents: Incident[];
  onNavigate: (queue: Queue) => void;
  onClose: () => void;
}) {
  const active = incidents.filter((incident) => incident.status !== "Resolved");
  return (
    <Modal title="Operations desk" onClose={onClose}>
      <p className="operations-summary">
        <strong>{active.length}</strong> active incidents across three queues
      </p>
      <p className="dialog-note">
        Queue health is based on unresolved incidents in this demo, not live service monitoring.
      </p>
      <ul className="operations-list">
        {queues
          .filter((queue) => queue !== "All incidents")
          .map((queue) => {
            const unresolved = active.filter((incident) => incident.queue === queue);
            const critical = unresolved.filter(
              (incident) => incident.severity === "Critical",
            ).length;
            return (
              <li key={queue}>
                <h3>{queue}</h3>
                <p>
                  {unresolved.length} active · {critical} critical
                </p>
                <span className={`queue-health ${unresolved.length ? "needs-attention" : ""}`}>
                  {unresolved.length ? "Needs attention" : "No active incidents"}
                </span>
                <Button className="secondary-button" onClick={() => onNavigate(queue)}>
                  View {queue} queue
                </Button>
              </li>
            );
          })}
      </ul>
    </Modal>
  );
}

export type Status = "Open" | "Investigating" | "Resolved";
export type Queue = "All incidents" | "Platform" | "Payments" | "Identity";
export type Incident = {
  id: string;
  title: string;
  service: string;
  queue: Exclude<Queue, "All incidents">;
  status: Status;
  severity: "Critical" | "High" | "Medium" | "Low";
  time: string;
  owner: string;
  favorite: boolean;
  activity: string[];
};

export const queues: Queue[] = ["All incidents", "Platform", "Payments", "Identity"];
export const statuses: Status[] = ["Open", "Investigating", "Resolved"];
const services = ["API gateway", "Checkout", "Authentication", "Worker pool", "Billing", "Search"];
const issues = [
  "Elevated error rate",
  "Latency above threshold",
  "Failed health checks",
  "Queue backlog",
  "Rate limit spike",
];
const owners = ["Alex Chen", "Sam Rivera", "Morgan Lee", "Taylor Kim"];

export const initialIncidents: Incident[] = Array.from({ length: 200 }, (_, index) => {
  const number = index + 1;
  const queue = queues[(index % 3) + 1] as Incident["queue"];
  return {
    id: `INC-${String(number).padStart(4, "0")}`,
    title: `${issues[index % issues.length]} in ${services[index % services.length]}`,
    service: services[index % services.length],
    queue,
    status: statuses[index % statuses.length],
    severity: (["Critical", "High", "Medium", "Low"] as const)[index % 4],
    time: `${String(9 + (index % 10)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`,
    owner: owners[index % owners.length],
    favorite: false,
    activity: ["Alert triggered by monitoring", "Assigned to on-call team"],
  };
});

export function visibleIncidents(
  incidents: Incident[],
  queue: Queue,
  search: string,
  status: string,
  sort: string,
) {
  const query = search.trim().toLowerCase();
  const filtered = incidents.filter(
    (incident) =>
      (queue === "All incidents" || incident.queue === queue) &&
      (status === "All statuses" || incident.status === status) &&
      (!query ||
        `${incident.id} ${incident.title} ${incident.service}`.toLowerCase().includes(query)),
  );
  if (sort === "severity") {
    const order = ["Critical", "High", "Medium", "Low"];
    return filtered.sort(
      (left, right) => order.indexOf(left.severity) - order.indexOf(right.severity),
    );
  }
  return sort === "oldest" ? filtered.reverse() : filtered;
}

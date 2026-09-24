import type { ComponentProps } from "react";
import type { Incident } from "./incidents";

export function Button(props: ComponentProps<"button">) {
  return <button {...props} />;
}

export function TextInput(props: ComponentProps<"input">) {
  return <input {...props} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} />;
}

export function StatusBadge({ status }: { status: Incident["status"] }) {
  return (
    <span className={`status-badge ${status.toLowerCase()}`}>
      <span />
      {status}
    </span>
  );
}

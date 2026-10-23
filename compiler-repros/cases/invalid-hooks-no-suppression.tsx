import { useEffect } from "react";

export function Example({ enabled, label }: { enabled: boolean; label: string }) {
  if (enabled) {
    useEffect(() => {
      document.title = label;
    }, [label]);
  }
  return <div>{label}</div>;
}

import { useEffect } from "react";

export function Example({ enabled, label }: { enabled: boolean; label: string }) {
  if (enabled) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      document.title = label;
    }, [label]);
  }
  return <div>{label}</div>;
}

import { useEffect } from "react";

export function Example({ label }: { label: string }) {
  useEffect(() => {
    document.title = label;
  }, [label]);
  return <div>{label}</div>;
}

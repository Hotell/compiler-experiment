import { useEffect } from "react";

export function Example({ label }: { label: string }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.title = label;
  }, [label]);
  return <div>{label}</div>;
}

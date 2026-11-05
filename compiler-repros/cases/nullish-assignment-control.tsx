import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({ reason, fallback }: { reason: string | undefined; fallback: string }) {
  const theme = useTheme();
  let blockingReason = reason;
  blockingReason = blockingReason ?? fallback;
  return <div className={theme}>{blockingReason}</div>;
}

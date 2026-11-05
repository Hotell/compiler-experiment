import { useCallback, useState, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({ save }: { save: () => Promise<void> }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const onClick = useCallback(async () => {
    setBusy(true);
    try {
      await save();
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }, [save]);
  return <button aria-label="Example" className={theme} disabled={busy} onClick={onClick} />;
}

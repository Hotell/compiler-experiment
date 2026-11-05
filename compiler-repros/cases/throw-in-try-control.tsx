import { useCallback, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({ id, open }: { id: string | undefined; open: (id: string) => void }) {
  const theme = useTheme();
  const onClick = useCallback(() => {
    if (!id) {
      console.error(new Error("Missing id"));
      return;
    }
    try {
      open(id);
    } catch (error) {
      console.error(error);
    }
  }, [id, open]);
  return <button aria-label="Example" className={theme} onClick={onClick} />;
}

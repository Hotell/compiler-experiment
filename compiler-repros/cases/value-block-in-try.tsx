import { useCallback, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({
  item,
  onSelect,
}: {
  item: { name?: string } | undefined;
  onSelect: (name: string) => void;
}) {
  const theme = useTheme();
  const onClick = useCallback(() => {
    try {
      onSelect(item?.name ?? "none");
    } catch (error) {
      console.error(error);
    }
  }, [item, onSelect]);
  return <button aria-label="Example" className={theme} onClick={onClick} />;
}

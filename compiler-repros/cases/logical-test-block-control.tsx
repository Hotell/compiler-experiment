import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");
const join = (...names: (string | false)[]) => names.filter(Boolean).join(" ");

export function Example({ mac, mini }: { mac: boolean; mini: boolean }) {
  const theme = useTheme();
  return (
    <header className={join(mac && "mac", mini && "mini")}>
      <span>{theme}</span>
    </header>
  );
}

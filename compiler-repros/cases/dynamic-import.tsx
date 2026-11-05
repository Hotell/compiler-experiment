import { useEffect, useState, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({ label }: { label: string }) {
  const theme = useTheme();
  const [name, setName] = useState("");
  useEffect(() => {
    void import("./module-opt-out-control").then((module) => setName(module.Example.name));
  }, []);
  return (
    <div className={theme}>
      {label}
      {name}
    </div>
  );
}

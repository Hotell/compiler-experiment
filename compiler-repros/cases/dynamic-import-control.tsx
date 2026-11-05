import { useEffect, useState, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");
import * as smoke from "./module-opt-out-control";

export function Example({ label }: { label: string }) {
  const theme = useTheme();
  const [name, setName] = useState("");
  useEffect(() => {
    void Promise.resolve(smoke).then((module) => setName(module.Example.name));
  }, []);
  return (
    <div className={theme}>
      {label}
      {name}
    </div>
  );
}

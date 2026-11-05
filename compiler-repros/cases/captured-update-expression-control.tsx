import { useEffect, useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const useTheme = () =>
  useSyncExternalStore(subscribe, () => localStorage.getItem("theme") ?? "light");

export function Example({ label }: { label: string }) {
  const theme = useTheme();
  useEffect(() => {
    let attempts = 0;
    const focus = () => {
      if (!document.querySelector("button") && attempts < 10) {
        attempts = attempts + 1;
        requestAnimationFrame(focus);
      }
    };
    requestAnimationFrame(focus);
  }, []);
  return <button className={theme}>{label}</button>;
}

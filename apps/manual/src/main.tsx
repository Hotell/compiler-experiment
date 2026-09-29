import { createRoot } from "react-dom/client";
import App from "./App";
import { Profiled } from "../../../benchmark/recorder";
import "../../../shared/styles.css";

createRoot(document.getElementById("root")!).render(
  import.meta.env.MODE === "profile" ? (
    <Profiled id="root">
      <App />
    </Profiled>
  ) : (
    <App />
  ),
);

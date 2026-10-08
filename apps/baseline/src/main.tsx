import { createRoot } from "react-dom/client";
import App from "../../../shared/App";
import { Profiled, TracksProfiled } from "../../../benchmark/recorder";
import "../../../shared/styles.css";

createRoot(document.getElementById("root")!).render(
  import.meta.env.MODE === "profile" ? (
    <Profiled id="root">
      <App />
    </Profiled>
  ) : import.meta.env.MODE === "profile-tracks" || import.meta.env.MODE === "profile-granular" ? (
    <TracksProfiled>
      <App />
    </TracksProfiled>
  ) : (
    <App />
  ),
);

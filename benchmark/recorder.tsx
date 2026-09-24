import type { ProfilerOnRenderCallback } from "react";

export type RenderRecord = {
  id: string;
  phase: string;
  actualDuration: number;
  commitTime: number;
};
declare global {
  interface Window {
    __benchmark?: { records: RenderRecord[]; clear: () => void };
  }
}

export const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  _baseDuration,
  _startTime,
  commitTime,
) => {
  window.__benchmark?.records.push({ id, phase, actualDuration, commitTime });
};

if (import.meta.env.MODE === "profile") {
  window.__benchmark = {
    records: [],
    clear() {
      this.records = [];
    },
  };
}

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./benchmark",
  testMatch: "profiler-overhead.spec.mts",
  outputDir: `${process.env.BENCHMARK_RESULTS_DIR ?? "benchmark/results"}/profiler-overhead/test-results`,
  workers: 1,
  retries: 0,
  reporter: "list",
  expect: { timeout: 10000 },
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  webServer: ["production", "profile-tracks", "profile-granular"].map((arm, armIndex) => {
    const port = 4575 + armIndex * 100;
    return {
      command: `yarn workspace @experiment/baseline exec vite preview --outDir ${arm === "production" ? "dist" : arm === "profile-tracks" ? "dist-profile-tracks" : "dist-profile-granular"} --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      timeout: 30000,
    };
  }),
});

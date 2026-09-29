import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./benchmark",
  testMatch: "row-ablation.spec.ts",
  outputDir: "test-results/row-ablation",
  workers: 1,
  retries: 0,
  reporter: "list",
  expect: { timeout: 10000 },
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10000,
    trace: "off",
  },
  webServer: [
    {
      command:
        "yarn workspace @experiment/manual exec vite preview --outDir dist-ablation/on/profile --host 127.0.0.1 --port 4371 --strictPort",
      url: "http://127.0.0.1:4371",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command:
        "yarn workspace @experiment/manual exec vite preview --outDir dist-ablation/off/profile --host 127.0.0.1 --port 4372 --strictPort",
      url: "http://127.0.0.1:4372",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command:
        "yarn workspace @experiment/manual exec vite preview --outDir dist-ablation/on/production --host 127.0.0.1 --port 4471 --strictPort",
      url: "http://127.0.0.1:4471",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command:
        "yarn workspace @experiment/manual exec vite preview --outDir dist-ablation/off/production --host 127.0.0.1 --port 4472 --strictPort",
      url: "http://127.0.0.1:4472",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});

import { defineConfig } from "@playwright/test";

const reuseCompilerPreview =
  process.env.BENCHMARK_REUSE_COMPILER_PREVIEW === "1" && !process.env.CI;

export default defineConfig({
  testDir: "./benchmark",
  testMatch: ["measure.spec.ts", "lighthouse.spec.ts"],
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium", trace: "retain-on-failure" },
  webServer: [
    {
      command: "yarn workspace @experiment/compiler preview:profile --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: reuseCompilerPreview,
      timeout: 30000,
    },
    {
      command: "yarn workspace @experiment/manual preview:profile --strictPort",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "yarn workspace @experiment/baseline preview:profile --strictPort",
      url: "http://127.0.0.1:4175",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "yarn workspace @experiment/compiler preview:normal --strictPort",
      url: "http://127.0.0.1:4273",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "yarn workspace @experiment/manual preview:normal --strictPort",
      url: "http://127.0.0.1:4274",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "yarn workspace @experiment/baseline preview:normal --strictPort",
      url: "http://127.0.0.1:4275",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});

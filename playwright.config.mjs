import { defineConfig } from "@playwright/test";

const PORT = 8080;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: process.env.BASE_URL || `http://localhost:${PORT}` },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `python3 -m http.server ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI
      }
});

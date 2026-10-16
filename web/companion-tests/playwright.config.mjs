// Playwright config for Tutor Companion end-to-end tests.
// Run from web/: npx playwright test -c companion-tests/playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.TC_PORT || 8765);
const PYTHON = process.env.PYTHON || "python";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.TC_BASE_URL || `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    serviceWorkers: "allow",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: "**/mobile.e2e.mjs" },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: "**/mobile.e2e.mjs" },
  ],
  webServer: {
    command: `${PYTHON} server.py --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/companion/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

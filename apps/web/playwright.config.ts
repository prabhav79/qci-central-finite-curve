import { defineConfig, devices } from "@playwright/test";

/**
 * CFC SuperDoc round-trip fixtures.
 *
 * These tests boot the API + Next dev server, then load each fixture DOCX
 * into SuperDoc, verify the editor reaches `ready`, export the blob, and
 * assert the exported bytes are a valid OOXML zip. Catches regressions in
 * SuperDoc that would break real QCI proposals.
 */
export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.CFC_WEB_BASE || "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--disable-web-security"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

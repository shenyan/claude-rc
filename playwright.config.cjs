const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts$/,  // *.test.ts are bun-test, not playwright
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:9876",
    trace: "off",
  },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 14"] } },
    { name: "ipad", use: { ...devices["iPad Pro 11"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
});

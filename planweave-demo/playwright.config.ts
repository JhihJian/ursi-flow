import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:4178", locale: "en-US", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: "npm run preview -- --port 4178 --strictPort",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false
  }
});

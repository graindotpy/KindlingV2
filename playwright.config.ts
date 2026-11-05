import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100/",
    timeout: 120_000,
    reuseExistingServer: false,
    // Tests use their own database and cannot contact household services, even
    // when a developer has a populated .env.local in this checkout.
    env: {
      DATABASE_PATH: "./test-results/browser.db",
      KINDLING_ADMIN_PASSWORD: "browser-test-password",
      KINDLING_SESSION_SECRET: "browser-test-session-secret-at-least-32-characters",
      KINDLING_EMBEDDED_WORKER: "false",
      KINDLING_TRUSTED_ORIGINS: "",
      READARR_BASE_URL: "", READARR_API_KEY: "",
      AUDIOBOOK_READARR_BASE_URL: "", AUDIOBOOK_READARR_API_KEY: "",
      SMTP_HOST: "", SMTP_FROM_EMAIL: "", SMTP_USERNAME: "", SMTP_PASSWORD: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});

import { defineConfig } from "@playwright/test";

/** Uçtan uca arayüz testleri: derlenmiş arayüz (dist) sahte arka uçla açılır.
 * Önce `npm run build`. */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4183",
    viewport: { width: 1440, height: 900 },
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "npx vite preview --port 4183 --strictPort",
    url: "http://localhost:4183",
    reuseExistingServer: !process.env.CI,
  },
});

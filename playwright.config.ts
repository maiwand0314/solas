import { defineConfig, devices } from "@playwright/test";

// Browser tests: the real app (production build) against its own database,
// filled by the tests themselves. No worker runs, so nothing calls Claude.
//
//   npm run test:e2e        (builds first; needs npm run db:up)

try {
  process.loadEnvFile(".env.local");
} catch {
  // Rely on variables already set in the environment (e.g. CI).
}

const PORT = 3100;

/** solas_test → solas_e2e_test: separate from both dev data and Vitest. */
export function e2eDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is not set. See .env.example.");
  const url = new URL(base);
  url.pathname = "/solas_e2e_test";
  return url.toString();
}

export default defineConfig({
  testDir: "e2e",
  // The tests share one database, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/conversations`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { DATABASE_URL: e2eDatabaseUrl(), SOLAS_LOCAL_OWNER_MODE: "true" },
  },
});

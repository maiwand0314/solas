import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests read DATABASE_URL / TEST_DATABASE_URL from .env.local, like the app.
try {
  process.loadEnvFile(".env.local");
} catch {
  // Rely on variables already set in the environment (e.g. CI).
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Outside Next.js, `import "server-only"` would throw. Tests run on the
      // server side by definition, so use the package's no-op entry.
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Integration tests share one test database, so run files one at a time.
    fileParallelism: false,
  },
});

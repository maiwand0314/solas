import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read .env.local on its own; Node 24 can, without dotenv.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on variables already set in the environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});

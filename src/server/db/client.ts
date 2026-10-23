import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Creates a Drizzle database backed by a small connection pool. Most code
 * should call getDatabase(); tests and scripts create their own.
 */
export function createDatabase(url: string) {
  const client = postgres(url, {
    max: 5,
    // Fail fast with a clear error instead of hanging when PostgreSQL is down.
    connect_timeout: 5,
    onnotice: () => {},
  });
  return drizzle({ client, schema });
}

/** Closes the pool so a script or test process can exit. */
export async function closeDatabase(db: Database) {
  await db.$client.end({ timeout: 5 });
}

// One pool per process. In development Next.js re-runs modules after every
// edit; keeping the pool on globalThis stops each reload opening new connections.
const globalForDatabase = globalThis as typeof globalThis & { solasDatabase?: Database };

export function getDatabase(): Database {
  if (!globalForDatabase.solasDatabase) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
    }
    globalForDatabase.solasDatabase = createDatabase(url);
  }
  return globalForDatabase.solasDatabase;
}

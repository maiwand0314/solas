import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import type { WorkerFailureCode, WorkerStep } from "@/server/db/schema";
import { truncate, type Logger } from "@/server/logger";
import { WORKER_HEALTH, type WorkerHealthLimits } from "./limits";

// The worker's side of worker health (M6C): it reports on itself in
// worker_instances, and the web app only reads (see status.ts).
//
// Every method here swallows its own errors: reporting health must never
// stop or slow the work it reports on. While the database is down nothing can
// be written; failures from that time wait in memory (bounded) and are saved
// with the first heartbeat that gets through.

export type StepFailure = { code: WorkerFailureCode; message: string };

const MESSAGES: Record<WorkerFailureCode, string> = {
  database_unavailable: "Couldn’t reach PostgreSQL. Is the database running?",
  query_failed: "A database query failed.",
  timeout: "The step took too long and was stopped.",
  unexpected: "An unexpected error. The worker’s log has the details.",
};

// postgres.js connection errors, and SQLSTATE classes that mean "no database right now".
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);
const UNAVAILABLE_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

/**
 * Turns an error into a code and a message Solas wrote itself. The raw error
 * text is never stored: it can contain a connection string or query values.
 * Only a PostgreSQL SQLSTATE (five letters/digits, no data) is added.
 */
export function classifyFailure(error: unknown): StepFailure {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    const code = typeof current === "object" ? (current as { code?: unknown }).code : undefined;
    if (typeof code !== "string") continue;
    if (CONNECTION_CODES.has(code) || code.startsWith("08") || UNAVAILABLE_SQLSTATES.has(code)) {
      return { code: "database_unavailable", message: MESSAGES.database_unavailable };
    }
    if (code === "57014") return { code: "timeout", message: MESSAGES.timeout };
    if (/^[0-9A-Z]{5}$/.test(code)) return { code: "query_failed", message: `${MESSAGES.query_failed} (PostgreSQL ${code})` };
  }
  if (error instanceof Error && error.name === "AbortError") return { code: "timeout", message: MESSAGES.timeout };
  return { code: "unexpected", message: MESSAGES.unexpected };
}

type Options = {
  db: Database;
  workerId: string;
  hostname: string;
  pid: number;
  startedAt?: Date;
  log: Logger;
  limits?: Pick<WorkerHealthLimits, "retentionMs" | "maxFailuresPerWorker" | "pruneIntervalMs" | "maxPendingFailures">;
};

const OK_COLUMN: Record<Exclude<WorkerStep, "queue">, string> = {
  scheduler: "last_scheduler_ok_at",
  notifications: "last_notifications_ok_at",
  recovery: "last_recovery_ok_at",
};

export function createWorkerHealth({ db, workerId, hostname, pid, startedAt = new Date(), log, limits = WORKER_HEALTH }: Options) {
  const pending: { step: WorkerStep; failure: StepFailure; at: Date }[] = [];
  let lastPrune = 0;
  let beating: Promise<void> | null = null;

  function warn(event: string, error: unknown) {
    log("warn", event, { workerId, error: truncate(error instanceof Error ? error.message : String(error)) });
  }

  async function saveFailure(step: WorkerStep, failure: StepFailure, at: Date | null) {
    await db.execute(sql`
      insert into worker_failures (worker_id, step, code, message, occurred_at)
      values (${workerId}, ${step}, ${failure.code}, ${failure.message}, ${at ? at.toISOString() : sql`now()`}::timestamptz)`);
  }

  async function prune() {
    const retention = sql.raw(`interval '${Math.round(limits.retentionMs / 1000)} seconds'`);
    // A worker that stopped (or vanished) long ago, with its failures (cascade)…
    await db.execute(sql`delete from worker_instances where last_heartbeat_at < now() - ${retention}`);
    // …old failures of workers that are still around…
    await db.execute(sql`delete from worker_failures where occurred_at < now() - ${retention}`);
    // …and anything beyond the newest N per worker.
    await db.execute(sql`
      delete from worker_failures f using (
        select id, row_number() over (partition by worker_id order by occurred_at desc, id) as n from worker_failures
      ) ranked
      where f.id = ranked.id and ranked.n > ${limits.maxFailuresPerWorker}`);
  }

  async function beat() {
    try {
      // An upsert, so a worker that started while the database was down still appears once it is back.
      await db.execute(sql`
        insert into worker_instances (id, hostname, pid, started_at, last_heartbeat_at)
        values (${workerId}, ${hostname}, ${pid}, ${startedAt.toISOString()}::timestamptz, now())
        on conflict (id) do update set last_heartbeat_at = now()`);
    } catch (error) {
      warn("worker.heartbeat_failed", error);
      return;
    }
    while (pending.length > 0) {
      const { step, failure, at } = pending[0];
      try {
        await saveFailure(step, failure, at);
        pending.shift();
      } catch (error) {
        warn("worker.health_write_failed", error);
        return;
      }
    }
    if (Date.now() - lastPrune >= limits.pruneIntervalMs) {
      try {
        await prune();
        lastPrune = Date.now();
      } catch (error) {
        warn("worker.health_prune_failed", error);
      }
    }
  }

  return {
    /** Writes the heartbeat (and anything waiting). Overlapping calls share one write. */
    heartbeat(): Promise<void> {
      beating ??= beat().finally(() => {
        beating = null;
      });
      return beating;
    },

    async succeeded(step: Exclude<WorkerStep, "queue">): Promise<void> {
      try {
        await db.execute(sql`update worker_instances set ${sql.raw(OK_COLUMN[step])} = now() where id = ${workerId}`);
      } catch (error) {
        warn("worker.health_write_failed", error);
      }
    },

    async failed(step: WorkerStep, error: unknown): Promise<void> {
      const failure = classifyFailure(error);
      try {
        await saveFailure(step, failure, null);
      } catch {
        // Most likely the database is down: keep it until a heartbeat gets through.
        if (pending.length >= limits.maxPendingFailures) pending.shift();
        pending.push({ step, failure, at: new Date() });
      }
    },

    /** Records a graceful shutdown. A crash never gets here; its heartbeat just goes stale. */
    async stopped(): Promise<void> {
      try {
        await db.execute(sql`update worker_instances set stopped_at = now(), last_heartbeat_at = now() where id = ${workerId}`);
      } catch (error) {
        warn("worker.health_write_failed", error);
      }
    },

    /** For tests: failures waiting for the database. */
    pendingCount: () => pending.length,
  };
}

export type WorkerHealth = ReturnType<typeof createWorkerHealth>;

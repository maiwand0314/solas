// Schedules for automations (M6A): what they mean, when they next run, and
// how they read. Pure functions with no dependencies, shared by the form
// (preview), the server (validation, next run), and the worker's scheduler.
//
// Times of day are wall-clock times in the automation's time zone, so "every
// day at 08:00 Europe/Oslo" stays at 08:00 across daylight saving changes.
// The conversion uses the platform's time zone data (Intl), no library:
//
// - A time that doesn't exist that day (02:30 when clocks jump from 02:00 to
//   03:00) runs at the same distance after the jump: 03:30.
// - A time that happens twice (02:30 when clocks fall back) runs once, the
//   first time.
//
// An interval ("every 2 hours") is elapsed time, counted from when the
// schedule was set, so it isn't affected by daylight saving at all.

export const WEEKDAYS = [
  { id: 1, short: "Mon", long: "Monday" },
  { id: 2, short: "Tue", long: "Tuesday" },
  { id: 3, short: "Wed", long: "Wednesday" },
  { id: 4, short: "Thu", long: "Thursday" },
  { id: 5, short: "Fri", long: "Friday" },
  { id: 6, short: "Sat", long: "Saturday" },
  { id: 7, short: "Sun", long: "Sunday" },
] as const;

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type Weekday = (typeof WEEKDAYS)[number]["id"];

export type Schedule =
  /** One run at a date and time. */
  | { kind: "once"; date: string; time: string }
  /** Every N minutes or hours, counted from when the schedule was set. */
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: Weekday[]; time: string }
  /** On this day of each month; in shorter months, on the last day. */
  | { kind: "monthly"; day: number; time: string };

export type ScheduleKind = Schedule["kind"];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type LocalDate = { year: number; month: number; day: number };
type LocalDateTime = LocalDate & { hour: number; minute: number };

// Formatters are expensive to create; one per time zone is enough.
const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether the platform knows this IANA time zone (e.g. "Europe/Oslo"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time at an instant in a time zone, as if it were UTC (milliseconds). */
function wallClockAsUtc(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The time zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockAsUtc(whole, timeZone) - whole;
}

/** The local date (in a time zone) of an instant. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const wall = new Date(wallClockAsUtc(instant.getTime(), timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/**
 * The instant a wall-clock time happens in a time zone. Looks at the offsets
 * a day before and after (time zones change offset at most once in that
 * span) and keeps the candidates that really show this wall-clock time:
 * two during a fall-back hour (the earlier wins), none in a spring-forward
 * gap (the time is moved forward by the gap's length).
 */
export function zonedTimeToInstant(local: LocalDateTime, timeZone: string): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((instant) => wallClockAsUtc(instant, timeZone) === wall)
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? wall - before);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function isoWeekday(date: LocalDate): Weekday {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
}

export function parseDate(date: string): LocalDate {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

/** Whether a calendar day matches a calendar schedule. */
function matchesDay(schedule: Exclude<Schedule, { kind: "once" | "interval" }>, date: LocalDate): boolean {
  if (schedule.kind === "daily") return true;
  if (schedule.kind === "weekly") return schedule.days.includes(isoWeekday(date));
  return date.day === Math.min(schedule.day, daysInMonth(date.year, date.month));
}

/** Milliseconds between interval runs. */
export function intervalMs(schedule: Extract<Schedule, { kind: "interval" }>): number {
  return schedule.every * (schedule.unit === "hours" ? 60 : 1) * MINUTE;
}

/**
 * The first run strictly after `after`, or null if there is none (a one-time
 * schedule whose time has passed). `anchor` is when the schedule was set:
 * interval runs fall at anchor + N × interval, never on the anchor itself.
 */
export function nextRunAfter(schedule: Schedule, timeZone: string, after: Date, anchor: Date): Date | null {
  const afterMs = after.getTime();
  switch (schedule.kind) {
    case "once": {
      const at = zonedTimeToInstant({ ...parseDate(schedule.date), ...parseTime(schedule.time) }, timeZone);
      return at.getTime() > afterMs ? at : null;
    }
    case "interval": {
      const step = intervalMs(schedule);
      const start = anchor.getTime();
      const count = afterMs < start ? 1 : Math.floor((afterMs - start) / step) + 1;
      return new Date(start + count * step);
    }
    default: {
      const time = parseTime(schedule.time);
      // Start a day early: the local date in the time zone may lag the instant.
      const first = addDays(localDateOf(after, timeZone), -1);
      // A monthly run is at most two months away; a year covers every case.
      for (let offset = 0; offset < 400; offset++) {
        const date = addDays(first, offset);
        if (!matchesDay(schedule, date)) continue;
        const at = zonedTimeToInstant({ ...date, ...time }, timeZone);
        if (at.getTime() > afterMs) return at;
      }
      return null;
    }
  }
}

/** The next `count` runs after `after`. */
export function upcomingRuns(schedule: Schedule, timeZone: string, after: Date, anchor: Date, count: number): Date[] {
  const runs: Date[] = [];
  let cursor = after;
  while (runs.length < count) {
    const next = nextRunAfter(schedule, timeZone, cursor, anchor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/** At most this many runs are walked through when working out what was missed. */
const MAX_WALK = 20_000;

export type DuePlan = {
  /** The run to start now, if one is recent enough. */
  run: Date | null;
  /** Runs that are too late to start: skipped and recorded, never caught up. */
  missed: { first: Date; last: Date; count: number; countIsLowerBound: boolean } | null;
  /** The next run after now, or null when the schedule has no more. */
  next: Date | null;
};

/**
 * What to do with an automation whose run time has come (`dueAt`, at or
 * before `now`). Of all runs due by now, only the latest may start, and
 * only if it is at most `graceMs` late; every other one is missed. So a
 * stopped worker never causes a burst of catch-up runs when it returns.
 */
export function planDueRuns(
  schedule: Schedule,
  timeZone: string,
  anchor: Date,
  dueAt: Date,
  now: Date,
  graceMs: number,
): DuePlan {
  const due: Date[] = [];
  let cursor: Date | null = dueAt;
  let walked = 0;
  while (cursor && cursor.getTime() <= now.getTime() && walked < MAX_WALK) {
    due.push(cursor);
    walked++;
    cursor = nextRunAfter(schedule, timeZone, cursor, anchor);
  }
  const countIsLowerBound = walked >= MAX_WALK;
  const latest = due.at(-1) ?? null;
  const runLatest = latest !== null && !countIsLowerBound && now.getTime() - latest.getTime() <= graceMs;
  const missedRuns = runLatest ? due.slice(0, -1) : due;
  return {
    run: runLatest ? latest : null,
    missed:
      missedRuns.length > 0
        ? { first: missedRuns[0], last: missedRuns.at(-1)!, count: missedRuns.length, countIsLowerBound }
        : null,
    next: nextRunAfter(schedule, timeZone, now, anchor),
  };
}

/** The most runs a schedule can make in one day: used to keep usage bounded. */
export function maxRunsPerDay(schedule: Schedule): number {
  if (schedule.kind !== "interval") return 1;
  return Math.ceil(DAY / intervalMs(schedule));
}

/** "Every day at 08:00", "Every 2 hours", "Once on 5 Nov 2026 at 08:00". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once": {
      const { year, month, day } = parseDate(schedule.date);
      const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, day)),
      );
      return `Once on ${date} at ${schedule.time}`;
    }
    case "interval": {
      const unit = schedule.unit === "hours" ? "hour" : "minute";
      return schedule.every === 1 ? `Every ${unit}` : `Every ${schedule.every} ${unit}s`;
    }
    case "daily":
      return `Every day at ${schedule.time}`;
    case "weekly": {
      const days = [...schedule.days].sort((a, b) => a - b);
      if (days.length === 7) return `Every day at ${schedule.time}`;
      if (days.join() === "1,2,3,4,5") return `Every weekday at ${schedule.time}`;
      if (days.join() === "6,7") return `Every weekend day at ${schedule.time}`;
      const names = days.map((id) => WEEKDAYS[id - 1].long);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      return `Every ${list} at ${schedule.time}`;
    }
    case "monthly": {
      const shorter = schedule.day > 28 ? " (the last day in shorter months)" : "";
      return `Monthly on day ${schedule.day} at ${schedule.time}${shorter}`;
    }
  }
}

/** An instant as the owner reads it in the automation's time zone: "Thu 5 Nov 2026, 08:00". */
export function formatInTimeZone(instant: Date, timeZone: string): string {
  // Built from parts, so the server and every browser write it the same way.
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** Every time zone the platform knows, for the form's list. */
export function timeZoneNames(): string[] {
  try {
    const names = Intl.supportedValuesOf("timeZone");
    return names.includes("UTC") ? names : [...names, "UTC"];
  } catch {
    return ["Europe/Oslo", "UTC"];
  }
}

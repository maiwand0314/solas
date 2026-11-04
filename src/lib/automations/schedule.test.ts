import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatInTimeZone,
  isValidTimeZone,
  maxRunsPerDay,
  nextRunAfter,
  planDueRuns,
  upcomingRuns,
  zonedTimeToInstant,
  type Schedule,
} from "./schedule";

// Pure schedule math: no database, no clock. Instants are written in UTC
// ("Z"); Oslo is UTC+1 in winter (CET) and UTC+2 in summer (CEST). In 2026,
// Europe switches to summer time on 29 March and back on 25 October.

const OSLO = "Europe/Oslo";
const at = (iso: string) => new Date(iso);
const anchor = at("2026-01-01T00:00:00Z");
const next = (schedule: Schedule, after: string, timeZone = OSLO) =>
  nextRunAfter(schedule, timeZone, at(after), anchor)?.toISOString() ?? null;

describe("wall-clock times in a time zone", () => {
  it("converts winter and summer times with the right offset", () => {
    expect(zonedTimeToInstant({ year: 2026, month: 1, day: 15, hour: 8, minute: 0 }, OSLO).toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
    expect(zonedTimeToInstant({ year: 2026, month: 7, day: 15, hour: 8, minute: 0 }, OSLO).toISOString()).toBe(
      "2026-07-15T06:00:00.000Z",
    );
  });

  it("moves a time in the spring-forward gap forward by the gap (02:30 → 03:30)", () => {
    const instant = zonedTimeToInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, OSLO);
    expect(instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatInTimeZone(instant, OSLO)).toContain("03:30");
  });

  it("uses the first of two 02:30s when clocks fall back", () => {
    const instant = zonedTimeToInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, OSLO);
    expect(instant.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST, not 02:30 CET
  });

  it("knows real time zones and rejects made-up ones", () => {
    expect(isValidTimeZone("Europe/Oslo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("the next run", () => {
  const daily: Schedule = { kind: "daily", time: "08:00" };

  it("daily: later today, or tomorrow once the time has passed", () => {
    expect(next(daily, "2026-01-15T06:00:00Z")).toBe("2026-01-15T07:00:00.000Z");
    expect(next(daily, "2026-01-15T07:00:00Z")).toBe("2026-01-16T07:00:00.000Z"); // strictly after
  });

  it("daily: stays at 08:00 Oslo time across both daylight saving changes", () => {
    const spring = upcomingRuns(daily, OSLO, at("2026-03-27T12:00:00Z"), anchor, 3).map((d) => d.toISOString());
    expect(spring).toEqual(["2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z", "2026-03-30T06:00:00.000Z"]);
    const autumn = upcomingRuns(daily, OSLO, at("2026-10-23T12:00:00Z"), anchor, 3).map((d) => d.toISOString());
    expect(autumn).toEqual(["2026-10-24T06:00:00.000Z", "2026-10-25T07:00:00.000Z", "2026-10-26T07:00:00.000Z"]);
    for (const run of [...spring, ...autumn]) expect(formatInTimeZone(at(run), OSLO)).toContain("08:00");
  });

  it("daily at 02:30 on the spring-forward day runs once, at 03:30", () => {
    const runs = upcomingRuns({ kind: "daily", time: "02:30" }, OSLO, at("2026-03-28T00:00:00Z"), anchor, 3);
    expect(runs.map((d) => formatInTimeZone(d, OSLO))).toEqual([
      "Sat 28 Mar 2026, 02:30",
      "Sun 29 Mar 2026, 03:30",
      "Mon 30 Mar 2026, 02:30",
    ]);
  });

  it("daily at 02:30 on the fall-back day runs once, not twice", () => {
    const runs = upcomingRuns({ kind: "daily", time: "02:30" }, OSLO, at("2026-10-24T12:00:00Z"), anchor, 2);
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
  });

  it("uses the automation's own time zone (New York changes on other dates)", () => {
    const nyc = "America/New_York";
    // 8 March 2026: New York springs forward; Oslo is still on winter time.
    const runs = upcomingRuns(daily, nyc, at("2026-03-07T00:00:00Z"), anchor, 2).map((d) => d.toISOString());
    expect(runs).toEqual(["2026-03-07T13:00:00.000Z", "2026-03-08T12:00:00.000Z"]);
  });

  it("weekly: only on the chosen days", () => {
    const weekly: Schedule = { kind: "weekly", days: [1, 3], time: "09:30" }; // Mon, Wed
    // Thu 15 Jan 2026 → Mon 19, Wed 21, Mon 26.
    const runs = upcomingRuns(weekly, OSLO, at("2026-01-15T12:00:00Z"), anchor, 3);
    expect(runs.map((d) => formatInTimeZone(d, OSLO))).toEqual([
      "Mon 19 Jan 2026, 09:30",
      "Wed 21 Jan 2026, 09:30",
      "Mon 26 Jan 2026, 09:30",
    ]);
  });

  it("weekly: the local day counts, not the UTC day", () => {
    // 00:30 Monday in Oslo is still Sunday in UTC.
    const weekly: Schedule = { kind: "weekly", days: [1], time: "00:30" };
    expect(next(weekly, "2026-01-17T12:00:00Z")).toBe("2026-01-18T23:30:00.000Z");
  });

  it("monthly: on the chosen day, or the last day of a shorter month", () => {
    const monthly: Schedule = { kind: "monthly", day: 31, time: "08:00" };
    const runs = upcomingRuns(monthly, OSLO, at("2026-01-31T12:00:00Z"), anchor, 4);
    expect(runs.map((d) => formatInTimeZone(d, OSLO))).toEqual([
      "Sat 28 Feb 2026, 08:00",
      "Tue 31 Mar 2026, 08:00",
      "Thu 30 Apr 2026, 08:00",
      "Sun 31 May 2026, 08:00",
    ]);
    // A leap year's February has 29 days.
    expect(formatInTimeZone(nextRunAfter(monthly, OSLO, at("2028-02-01T00:00:00Z"), anchor)!, OSLO)).toBe(
      "Tue 29 Feb 2028, 08:00",
    );
  });

  it("interval: counted from the anchor, never on it, unaffected by daylight saving", () => {
    const every2h: Schedule = { kind: "interval", every: 2, unit: "hours" };
    const set = at("2026-03-29T00:15:00Z");
    expect(nextRunAfter(every2h, OSLO, set, set)!.toISOString()).toBe("2026-03-29T02:15:00.000Z");
    const runs = upcomingRuns(every2h, OSLO, set, set, 3).map((d) => d.getTime() - set.getTime());
    expect(runs).toEqual([2, 4, 6].map((hours) => hours * 3_600_000));
    // Later on, it keeps to the same grid instead of drifting.
    expect(nextRunAfter(every2h, OSLO, at("2026-03-30T05:00:00Z"), set)!.toISOString()).toBe("2026-03-30T06:15:00.000Z");
  });

  it("once: the time itself, then nothing", () => {
    const once: Schedule = { kind: "once", date: "2026-07-01", time: "12:00" };
    expect(next(once, "2026-06-30T00:00:00Z")).toBe("2026-07-01T10:00:00.000Z");
    expect(next(once, "2026-07-01T10:00:00Z")).toBeNull();
  });
});

describe("runs that are due", () => {
  const daily: Schedule = { kind: "daily", time: "08:00" };
  const grace = 10 * 60_000;

  it("starts a run that is on time and plans the next one", () => {
    const plan = planDueRuns(daily, OSLO, anchor, at("2026-01-15T07:00:00Z"), at("2026-01-15T07:00:20Z"), grace);
    expect(plan.run?.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(plan.missed).toBeNull();
    expect(plan.next?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  it("skips a run that is too late, and doesn't catch up", () => {
    const plan = planDueRuns(daily, OSLO, anchor, at("2026-01-15T07:00:00Z"), at("2026-01-15T09:00:00Z"), grace);
    expect(plan.run).toBeNull();
    expect(plan.missed).toMatchObject({ count: 1 });
    expect(plan.next?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  it("after days of downtime: records every missed run once, starts none of them", () => {
    const plan = planDueRuns(daily, OSLO, anchor, at("2026-01-10T07:00:00Z"), at("2026-01-15T12:00:00Z"), grace);
    expect(plan.run).toBeNull();
    expect(plan.missed?.count).toBe(6); // 10th to 15th
    expect(plan.missed?.first.toISOString()).toBe("2026-01-10T07:00:00.000Z");
    expect(plan.missed?.last.toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });

  it("downtime that ends just after a run: that run starts, the earlier ones are missed", () => {
    const hourly: Schedule = { kind: "interval", every: 1, unit: "hours" };
    const set = at("2026-01-15T00:00:00Z");
    const plan = planDueRuns(hourly, OSLO, set, at("2026-01-15T01:00:00Z"), at("2026-01-15T04:02:00Z"), grace);
    expect(plan.run?.toISOString()).toBe("2026-01-15T04:00:00.000Z");
    expect(plan.missed?.count).toBe(3);
    expect(plan.next?.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("a missed one-time run has no next run", () => {
    const once: Schedule = { kind: "once", date: "2026-01-15", time: "08:00" };
    const plan = planDueRuns(once, OSLO, anchor, at("2026-01-15T07:00:00Z"), at("2026-01-15T08:00:00Z"), grace);
    expect(plan).toMatchObject({ run: null, missed: { count: 1 }, next: null });
  });
});

describe("usage bounds and descriptions", () => {
  it("counts the most runs a schedule can make in a day", () => {
    expect(maxRunsPerDay({ kind: "interval", every: 1, unit: "hours" })).toBe(24);
    expect(maxRunsPerDay({ kind: "interval", every: 90, unit: "minutes" })).toBe(16);
    expect(maxRunsPerDay({ kind: "daily", time: "08:00" })).toBe(1);
    expect(maxRunsPerDay({ kind: "weekly", days: [1, 2, 3], time: "08:00" })).toBe(1);
  });

  it("describes schedules in plain words", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("Every day at 08:00");
    expect(describeSchedule({ kind: "interval", every: 1, unit: "hours" })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", every: 90, unit: "minutes" })).toBe("Every 90 minutes");
    expect(describeSchedule({ kind: "weekly", days: [5, 1], time: "09:00" })).toBe("Every Monday and Friday at 09:00");
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" })).toBe("Every weekday at 09:00");
    expect(describeSchedule({ kind: "monthly", day: 31, time: "07:00" })).toBe(
      "Monthly on day 31 at 07:00 (the last day in shorter months)",
    );
    expect(describeSchedule({ kind: "once", date: "2026-11-05", time: "08:00" })).toBe("Once on 5 Nov 2026 at 08:00");
  });
});

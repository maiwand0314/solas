import type { Schedule, ScheduleKind, Weekday } from "./schedule";

// The automation form's fields and how they map to a stored schedule.
// Client-safe and server-safe: the edit page fills the form on the server.

/** Every schedule field at once, so switching the kind keeps what was typed. */
export type AutomationFormValues = {
  name: string;
  description: string;
  agentId: string;
  instructions: string;
  kind: ScheduleKind;
  date: string;
  time: string;
  every: string;
  unit: "minutes" | "hours";
  days: Weekday[];
  day: string;
  timeZone: string;
  enabled: boolean;
};

type ScheduleFields = Pick<AutomationFormValues, "kind" | "date" | "time" | "every" | "unit" | "days" | "day">;

/** Turns the form's fields into the schedule the server stores. */
export function scheduleFromValues(values: ScheduleFields): Schedule {
  switch (values.kind) {
    case "once":
      return { kind: "once", date: values.date, time: values.time };
    case "interval":
      return { kind: "interval", every: Number(values.every), unit: values.unit };
    case "daily":
      return { kind: "daily", time: values.time };
    case "weekly":
      return { kind: "weekly", days: [...values.days].sort((a, b) => a - b), time: values.time };
    case "monthly":
      return { kind: "monthly", day: Number(values.day), time: values.time };
  }
}

/** Fills every form field from a stored schedule (the others get defaults). */
export function valuesFromSchedule(schedule: Schedule): ScheduleFields {
  return {
    kind: schedule.kind,
    date: schedule.kind === "once" ? schedule.date : "",
    time: "time" in schedule ? schedule.time : "08:00",
    every: schedule.kind === "interval" ? String(schedule.every) : "2",
    unit: schedule.kind === "interval" ? schedule.unit : "hours",
    days: schedule.kind === "weekly" ? schedule.days : [1],
    day: schedule.kind === "monthly" ? String(schedule.day) : "1",
  };
}


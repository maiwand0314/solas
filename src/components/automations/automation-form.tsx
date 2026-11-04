"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { createAutomation, updateAutomation } from "@/app/(app)/automations/actions";
import { useUnsavedChangesGuard } from "@/components/agents/use-unsaved-changes";
import { Button, buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldAria } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/components/use-now";
import type { FieldErrors } from "@/lib/agents/validation";
import { AUTOMATION_LIMITS, DEFAULT_TIME_ZONE } from "@/lib/automations/limits";
import { scheduleFromValues, valuesFromSchedule, type AutomationFormValues } from "@/lib/automations/form-values";
import { WEEKDAYS, formatInTimeZone, maxRunsPerDay, upcomingRuns, type ScheduleKind, type Weekday } from "@/lib/automations/schedule";
import { automationSchema, scheduleSchema } from "@/lib/automations/validation";
import { TASK_LIMITS } from "@/lib/tasks/validation";

/** An agent the automation can use. Only ready agents can be chosen (plus the current one when editing). */
export type AutomationAgentOption = { id: string; name: string; role: string; ready: boolean };

type Values = AutomationFormValues;

type AutomationFormProps = {
  agents: AutomationAgentOption[];
  /** Time zone names, from the server so both sides list the same ones. */
  timeZones: string[];
} & ({ mode: "create"; automation?: undefined } | { mode: "edit"; automation: { id: string } & Values });

const KINDS: { id: ScheduleKind; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week, on chosen days" },
  { id: "monthly", label: "Every month, on one day" },
  { id: "interval", label: "Every few hours" },
  { id: "once", label: "Once" },
];

const FIELD_ORDER = ["name", "description", "agentId", "instructions", "schedule", "timeZone"] as const;

/**
 * Create or edit an automation: what the agent should do and when. Checks
 * with the server's schema first (the server checks again, plus the rules
 * that need the clock and the database). The preview shows the next runs
 * if it were saved now, computed with the same code the worker uses.
 */
export function AutomationForm({ mode, automation, agents, timeZones }: AutomationFormProps) {
  const router = useRouter();
  const idPrefix = useId();
  const fieldId = (field: string) => `${idPrefix}-${field}`;
  const [initial] = useState<Values>(
    () =>
      automation ?? {
        name: "",
        description: "",
        agentId: agents.find((agent) => agent.ready)?.id ?? "",
        instructions: "",
        ...valuesFromSchedule({ kind: "daily", time: "08:00" }),
        timeZone: DEFAULT_TIME_ZONE,
        enabled: true,
      },
  );
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // The browser's clock, after hydration (null before): only for the preview.
  const now = useNow(false);

  const toInput = (from: Values) => ({
    name: from.name,
    description: from.description,
    agentId: from.agentId,
    instructions: from.instructions,
    schedule: scheduleFromValues(from),
    timeZone: from.timeZone,
    enabled: from.enabled,
  });
  const dirty = JSON.stringify(toInput(values)) !== JSON.stringify(toInput(initial));
  useUnsavedChangesGuard(dirty && !saved);

  function setField<K extends keyof Values>(field: K, value: Values[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    const errorKey = ["kind", "date", "time", "every", "unit", "days", "day"].includes(field) ? "schedule" : field;
    if (errors[errorKey]) setErrors((current) => ({ ...current, [errorKey]: undefined }));
  }

  function toggleDay(day: Weekday, checked: boolean) {
    setField("days", checked ? [...values.days, day] : values.days.filter((existing) => existing !== day));
  }

  function showErrors(fieldErrors: FieldErrors, message: string | null) {
    setErrors(fieldErrors);
    setFormError(message);
    const first = FIELD_ORDER.find((field) => fieldErrors[field]?.length);
    if (first) requestAnimationFrame(() => document.getElementById(fieldId(first))?.focus());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = toInput(values);
    const check = automationSchema.safeParse(input);
    if (!check.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of check.error.issues) {
        const field = String(issue.path[0] ?? "");
        (fieldErrors[field] ??= []).push(issue.message);
      }
      showErrors(fieldErrors, fieldErrors[""]?.[0] ?? null);
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      try {
        const result = mode === "create" ? await createAutomation(input) : await updateAutomation(automation.id, input);
        if (!result.ok) {
          const hasFieldErrors = Object.values(result.error.fieldErrors).some((list) => list?.length);
          showErrors(result.error.fieldErrors, hasFieldErrors ? null : result.error.message);
          return;
        }
        setSaved(true);
        toast.success(mode === "create" ? `Created “${result.data.name}”.` : "Changes saved.");
        router.push(`/automations/${result.data.id}`);
      } catch {
        setFormError("Couldn’t reach Solas. Check that it’s running, then try again.");
      }
    });
  }

  const errorFor = (field: string) => errors[field]?.[0];
  const schedule = scheduleFromValues(values);
  const validSchedule = scheduleSchema.safeParse(schedule).success;
  const preview =
    now !== null && validSchedule ? upcomingRuns(schedule, values.timeZone, new Date(now), new Date(now), 3) : [];
  const perDay = validSchedule ? maxRunsPerDay(schedule) : null;
  const selectable = agents.filter((agent) => agent.ready || agent.id === initial.agentId);

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} className="flex max-w-2xl flex-col gap-6">
      <Field
        id={fieldId("name")}
        label="Name"
        required
        error={errorFor("name")}
        aside={<CharacterCount value={values.name} max={AUTOMATION_LIMITS.name} />}
      >
        <Input
          name="name"
          {...fieldAria(fieldId("name"), { error: errorFor("name") })}
          value={values.name}
          onChange={(event) => setField("name", event.target.value)}
          maxLength={AUTOMATION_LIMITS.name}
          autoComplete="off"
          placeholder="Daily AI Research Briefing"
          required
        />
      </Field>
      <Field
        id={fieldId("description")}
        label="Description"
        hint="For you: what this automation is for."
        error={errorFor("description")}
        aside={<CharacterCount value={values.description} max={AUTOMATION_LIMITS.description} />}
      >
        <Textarea
          name="description"
          {...fieldAria(fieldId("description"), { hint: true, error: errorFor("description") })}
          value={values.description}
          onChange={(event) => setField("description", event.target.value)}
          maxLength={AUTOMATION_LIMITS.description}
          rows={2}
        />
      </Field>

      <Field
        id={fieldId("agentId")}
        label="Agent"
        required
        hint="Each run is a task for this agent, with its own tools and approvals."
        error={errorFor("agentId")}
      >
        <Select
          name="agentId"
          {...fieldAria(fieldId("agentId"), { hint: true, error: errorFor("agentId") })}
          value={values.agentId}
          onChange={(event) => setField("agentId", event.target.value)}
          disabled={selectable.length === 0}
        >
          {selectable.length === 0 && <option value="">No agent can run tasks yet</option>}
          {selectable.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {agent.role ? ` — ${agent.role}` : ""}
              {agent.ready ? "" : " (can’t run now)"}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={fieldId("instructions")}
        label="Task instructions"
        required
        hint="What the agent is asked to do on every run."
        error={errorFor("instructions")}
        aside={<CharacterCount value={values.instructions} max={TASK_LIMITS.instructions} />}
      >
        <Textarea
          name="instructions"
          {...fieldAria(fieldId("instructions"), { hint: true, error: errorFor("instructions") })}
          value={values.instructions}
          onChange={(event) => setField("instructions", event.target.value)}
          maxLength={TASK_LIMITS.instructions}
          rows={6}
          required
        />
      </Field>

      <fieldset
        id={fieldId("schedule")}
        tabIndex={-1}
        aria-describedby={errorFor("schedule") ? `${fieldId("schedule")}-error` : undefined}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 focus:outline-none"
      >
        <legend className="px-1 text-sm font-medium">When it runs</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={fieldId("kind")} label="Repeats" required>
            <Select
              name="kind"
              id={fieldId("kind")}
              value={values.kind}
              onChange={(event) => setField("kind", event.target.value as ScheduleKind)}
            >
              {KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              ))}
            </Select>
          </Field>
          {values.kind === "interval" ? (
            <div className="grid grid-cols-[5rem_1fr] gap-2">
              <Field id={fieldId("every")} label="Every" required>
                <Input
                  name="every"
                  id={fieldId("every")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={values.every}
                  onChange={(event) => setField("every", event.target.value)}
                />
              </Field>
              <Field id={fieldId("unit")} label="Unit" required>
                <Select
                  name="unit"
                  id={fieldId("unit")}
                  value={values.unit}
                  onChange={(event) => setField("unit", event.target.value as Values["unit"])}
                >
                  <option value="hours">hours</option>
                  <option value="minutes">minutes</option>
                </Select>
              </Field>
            </div>
          ) : (
            <Field id={fieldId("time")} label="Time" required>
              <Input
                name="time"
                id={fieldId("time")}
                type="time"
                value={values.time}
                onChange={(event) => setField("time", event.target.value)}
              />
            </Field>
          )}
          {values.kind === "once" && (
            <Field id={fieldId("date")} label="Date" required>
              <Input
                name="date"
                id={fieldId("date")}
                type="date"
                value={values.date}
                onChange={(event) => setField("date", event.target.value)}
              />
            </Field>
          )}
          {values.kind === "monthly" && (
            <Field id={fieldId("day")} label="Day of the month" required hint="In shorter months, the last day.">
              <Select
                name="day"
                {...fieldAria(fieldId("day"), { hint: true })}
                value={values.day}
                onChange={(event) => setField("day", event.target.value)}
              >
                {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {values.kind === "weekly" && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Days</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((weekday) => {
                const id = `${idPrefix}-day-${weekday.id}`;
                const checked = values.days.includes(weekday.id);
                return (
                  <label
                    key={weekday.id}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm has-[:checked]:border-accent"
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggleDay(weekday.id, event.target.checked)}
                      className="size-4 cursor-pointer accent-accent"
                      aria-label={weekday.long}
                    />
                    <span aria-hidden="true">{weekday.short}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <Field
          id={fieldId("timeZone")}
          label="Time zone"
          required
          hint="Times are wall-clock times here, so 08:00 stays 08:00 when daylight saving changes."
          error={errorFor("timeZone")}
        >
          <Select
            name="timeZone"
            {...fieldAria(fieldId("timeZone"), { hint: true, error: errorFor("timeZone") })}
            value={values.timeZone}
            onChange={(event) => setField("timeZone", event.target.value)}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Field>

        {errorFor("schedule") && (
          <p id={`${fieldId("schedule")}-error`} role="alert" className="text-sm text-danger">
            {errorFor("schedule")}
          </p>
        )}
        <div aria-live="polite" className="border-t border-border pt-3 text-sm">
          {validSchedule && preview.length > 0 ? (
            <>
              <p className="text-muted">If you save now, it runs next:</p>
              <ul className="mt-1 flex flex-col gap-0.5 tabular-nums">
                {preview.map((run) => (
                  <li key={run.toISOString()}>{formatInTimeZone(run, values.timeZone)}</li>
                ))}
              </ul>
              {perDay !== null && perDay > 1 && (
                <p className="mt-2 text-subtle">
                  Up to {perDay} runs a day. Each run is a Claude run on your plan.
                </p>
              )}
            </>
          ) : validSchedule && now !== null ? (
            <p className="text-muted">This time has already passed. Choose a time in the future.</p>
          ) : (
            <p className="text-muted">Complete the schedule to see when it runs.</p>
          )}
        </div>
      </fieldset>

      <div className="flex items-start gap-3">
        <Switch
          id={fieldId("enabled")}
          checked={values.enabled}
          onCheckedChange={(checked) => setField("enabled", checked)}
          aria-labelledby={`${fieldId("enabled")}-label`}
          aria-describedby={`${fieldId("enabled")}-hint`}
          className="mt-0.5"
        />
        <div>
          <p id={`${fieldId("enabled")}-label`} className="text-sm font-medium">
            {values.enabled ? "Active" : "Paused"}
          </p>
          <p id={`${fieldId("enabled")}-hint`} className="text-sm text-muted">
            {values.enabled
              ? "Runs on its schedule while the worker is running."
              : "Saved without a schedule. Resume it whenever you like."}
          </p>
        </div>
      </div>

      {formError && (
        <Callout tone="danger" role="alert">
          {formError}
        </Callout>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <p className="mr-auto text-sm text-subtle" aria-live="polite">
          {dirty && !saved ? "Unsaved changes" : ""}
        </p>
        <Link
          href={mode === "create" ? "/automations" : `/automations/${automation.id}`}
          className={buttonClassName({ variant: "secondary" })}
        >
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending || saved || (mode === "edit" && !dirty)}>
          {pending ? (mode === "create" ? "Creating…" : "Saving…") : mode === "create" ? "Create automation" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function CharacterCount({ value, max }: { value: string; max: number }) {
  const near = value.length > max * 0.9;
  return (
    <span className={near ? "text-xs text-danger tabular-nums" : "text-xs text-subtle tabular-nums"}>
      {value.length.toLocaleString("en")} / {max.toLocaleString("en")}
    </span>
  );
}

/** Shown while an automation form's data loads. */
export function AutomationFormSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex max-w-2xl flex-col gap-6">
      <span className="sr-only">Loading…</span>
      {[8, 16, 8, 40, 40].map((height, index) => (
        <div key={index}>
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className={height === 8 ? "h-8 w-full" : height === 16 ? "h-16 w-full" : "h-40 w-full"} />
        </div>
      ))}
    </div>
  );
}

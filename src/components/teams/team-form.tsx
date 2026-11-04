"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { createTeam, updateTeam } from "@/app/(app)/teams/actions";
import { useUnsavedChangesGuard } from "@/components/agents/use-unsaved-changes";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldAria } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { FieldErrors } from "@/lib/agents/validation";
import { createTeamSchema, TEAM_LIMITS, updateTeamSchema } from "@/lib/teams/validation";

/** An agent that can be added to a team, as plain data. */
export type TeamAgentOption = { id: string; name: string; role: string; enabled: boolean };

type Values = { name: string; description: string; memberIds: string[]; coordinatorId: string };

type TeamFormProps = {
  agents: TeamAgentOption[];
} & ({ mode: "create"; team?: undefined } | { mode: "edit"; team: { id: string } & Values });

const FIELD_ORDER = ["name", "description", "memberIds", "coordinatorId"] as const;

/**
 * Create or edit a team: name, description, members, and coordinator.
 * Validates with the server's schema first; the server checks again. The
 * coordinator is chosen from the members. Membership grants nothing: who may
 * delegate to whom is set on the team page.
 */
export function TeamForm({ mode, team, agents }: TeamFormProps) {
  const router = useRouter();
  const idPrefix = useId();
  const fieldId = (field: string) => `${idPrefix}-${field}`;
  const [initial] = useState<Values>(() => team ?? { name: "", description: "", memberIds: [], coordinatorId: "" });
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const toInput = (from: Values) => ({
    name: from.name,
    description: from.description,
    // In list order, so an unchanged selection compares equal.
    memberIds: agents.map((agent) => agent.id).filter((id) => from.memberIds.includes(id)),
    coordinatorId: from.coordinatorId || null,
  });
  const changes = Object.fromEntries(
    Object.entries(toInput(values)).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(toInput(initial)[key as keyof Values]),
    ),
  );
  const dirty = Object.keys(changes).length > 0;
  useUnsavedChangesGuard(dirty && !saved);
  const members = agents.filter((agent) => values.memberIds.includes(agent.id));

  function setField<K extends keyof Values>(field: K, value: Values[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function toggleMember(id: string, checked: boolean) {
    const memberIds = checked ? [...values.memberIds, id] : values.memberIds.filter((existing) => existing !== id);
    setValues((current) => ({
      ...current,
      memberIds,
      // A removed coordinator stops being coordinator.
      coordinatorId: memberIds.includes(current.coordinatorId) ? current.coordinatorId : "",
    }));
    if (errors.memberIds) setErrors((current) => ({ ...current, memberIds: undefined }));
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
    const input = mode === "create" ? toInput(values) : changes;
    const check = (mode === "create" ? createTeamSchema : updateTeamSchema).safeParse(input);
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
        const result = mode === "create" ? await createTeam(input) : await updateTeam(team.id, input);
        if (!result.ok) {
          const hasFieldErrors = Object.values(result.error.fieldErrors).some((list) => list?.length);
          showErrors(result.error.fieldErrors, hasFieldErrors ? null : result.error.message);
          return;
        }
        setSaved(true);
        toast.success(mode === "create" ? `Created “${result.data.name}”.` : "Changes saved.");
        router.push(`/teams/${result.data.id}`);
      } catch {
        setFormError("Couldn’t reach Solas. Check that it’s running, then try again.");
      }
    });
  }

  const errorFor = (field: keyof Values) => errors[field]?.[0];

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} className="flex max-w-2xl flex-col gap-6">
      <Field
        id={fieldId("name")}
        label="Name"
        required
        error={errorFor("name")}
        aside={<CharacterCount value={values.name} max={TEAM_LIMITS.name} />}
      >
        <Input
          name="name"
          {...fieldAria(fieldId("name"), { error: errorFor("name") })}
          value={values.name}
          onChange={(event) => setField("name", event.target.value)}
          maxLength={TEAM_LIMITS.name}
          autoComplete="off"
          placeholder="Solas Development Team"
          required
        />
      </Field>
      <Field
        id={fieldId("description")}
        label="Description"
        hint="What the team works on."
        error={errorFor("description")}
        aside={<CharacterCount value={values.description} max={TEAM_LIMITS.description} />}
      >
        <Textarea
          name="description"
          {...fieldAria(fieldId("description"), { hint: true, error: errorFor("description") })}
          value={values.description}
          onChange={(event) => setField("description", event.target.value)}
          maxLength={TEAM_LIMITS.description}
          rows={3}
        />
      </Field>

      <fieldset
        id={fieldId("memberIds")}
        tabIndex={-1}
        aria-describedby={`${fieldId("memberIds")}-hint${errorFor("memberIds") ? ` ${fieldId("memberIds")}-error` : ""}`}
        className="flex flex-col gap-1.5 focus:outline-none"
      >
        <legend className="mb-1.5 text-sm font-medium">
          Members<span className="ml-1.5 text-xs font-normal text-subtle">Optional</span>
        </legend>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">
            No agents yet. <Link href="/agents/new" className="text-foreground underline underline-offset-2">Create an agent</Link> first.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {agents.map((agent) => {
              const id = `${idPrefix}-agent-${agent.id}`;
              return (
                <li key={agent.id}>
                  <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-hover/60">
                    <input
                      id={id}
                      type="checkbox"
                      checked={values.memberIds.includes(agent.id)}
                      onChange={(event) => toggleMember(agent.id, event.target.checked)}
                      className="size-4 shrink-0 cursor-pointer accent-accent"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{agent.name}</span>
                      {agent.role && <span className="ml-2 text-sm text-muted">{agent.role}</span>}
                    </span>
                    {!agent.enabled && <Badge>Disabled</Badge>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p id={`${fieldId("memberIds")}-hint`} className="text-sm text-muted">
          Being in a team doesn’t let an agent delegate. You choose who may delegate to whom on the team’s page.
        </p>
        {errorFor("memberIds") && (
          <p id={`${fieldId("memberIds")}-error`} className="text-sm text-danger">
            {errorFor("memberIds")}
          </p>
        )}
      </fieldset>

      <Field
        id={fieldId("coordinatorId")}
        label="Coordinator"
        hint="The member who leads the team’s work. A label for you and the team page; it grants no extra permissions."
        error={errorFor("coordinatorId")}
      >
        <Select
          name="coordinatorId"
          {...fieldAria(fieldId("coordinatorId"), { hint: true, error: errorFor("coordinatorId") })}
          value={values.coordinatorId}
          onChange={(event) => setField("coordinatorId", event.target.value)}
          disabled={members.length === 0}
        >
          <option value="">{members.length === 0 ? "Add members first" : "No coordinator"}</option>
          {members.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
      </Field>

      {formError && (
        <Callout tone="danger" role="alert">
          {formError}
        </Callout>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <p className="mr-auto text-sm text-subtle" aria-live="polite">
          {dirty && !saved ? "Unsaved changes" : ""}
        </p>
        <Link href={mode === "create" ? "/teams" : `/teams/${team.id}`} className={buttonClassName({ variant: "secondary" })}>
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending || saved || (mode === "edit" && !dirty)}>
          {pending ? (mode === "create" ? "Creating…" : "Saving…") : mode === "create" ? "Create team" : "Save changes"}
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

/** Shown while a team form's data loads. */
export function TeamFormSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex max-w-2xl flex-col gap-6">
      <span className="sr-only">Loading…</span>
      {[8, 16, 40].map((height, index) => (
        <div key={index}>
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className={height === 8 ? "h-8 w-full" : height === 16 ? "h-16 w-full" : "h-40 w-full"} />
        </div>
      ))}
    </div>
  );
}

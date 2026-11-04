"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { createTask } from "@/app/(app)/tasks/actions";
import { useUnsavedChangesGuard } from "@/components/agents/use-unsaved-changes";
import { Button, buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldAria } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { FieldErrors } from "@/lib/agents/validation";
import { createTaskSchema, TASK_LIMITS } from "@/lib/tasks/validation";

/** An agent that can take a task right now, as plain data. */
export type TaskAgentOption = {
  id: string;
  name: string;
  role: string;
  /** "Claude · Opus 5.5". */
  modelLabel: string;
  /** The agent's enabled tools, e.g. "Read workspace file (asks first)". */
  tools: string[];
};

type Values = { agentId: string; title: string; instructions: string };
const FIELD_ORDER = ["agentId", "title", "instructions"] as const;

/**
 * The New task form. Validates in the browser with the server's own schema,
 * then calls createTask. Each submit carries a request ID that is reused if
 * the same submit is sent again (double click, dropped connection), so the
 * server creates the task once. The agent runs with its saved instructions,
 * model, and tool permissions: a task can't grant it anything more.
 */
export function TaskForm({ agents }: { agents: TaskAgentOption[] }) {
  const router = useRouter();
  const idPrefix = useId();
  const fieldId = (field: string) => `${idPrefix}-${field}`;
  const [values, setValues] = useState<Values>({
    agentId: agents.length === 1 ? agents[0].id : "",
    title: "",
    instructions: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();
  const requestId = useRef<string | null>(null);

  const dirty = values.title.trim() !== "" || values.instructions.trim() !== "";
  useUnsavedChangesGuard(dirty && !submitted);
  const selected = agents.find((agent) => agent.id === values.agentId);

  function setField(field: keyof Values, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    requestId.current = null; // a changed form is a new request
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function showErrors(fieldErrors: FieldErrors, message: string | null) {
    setErrors(fieldErrors);
    setFormError(message);
    const first = FIELD_ORDER.find((field) => fieldErrors[field]?.length);
    if (first) requestAnimationFrame(() => document.getElementById(fieldId(first))?.focus());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || submitted) return;
    const check = createTaskSchema.safeParse(values);
    if (!check.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of check.error.issues) {
        const field = String(issue.path[0] ?? "");
        fieldErrors[field] ??= [];
        fieldErrors[field]!.push(field === "agentId" ? "Choose an agent." : issue.message);
      }
      showErrors(fieldErrors, null);
      return;
    }
    requestId.current ??= crypto.randomUUID();
    const input = { ...check.data, clientRequestId: requestId.current };
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      try {
        const result = await createTask(input);
        if (!result.ok) {
          const hasFieldErrors = Object.values(result.error.fieldErrors).some((list) => list?.length);
          showErrors(result.error.fieldErrors, hasFieldErrors ? null : result.error.message);
          return;
        }
        setSubmitted(true);
        toast.success(`Queued “${check.data.title}”.`);
        router.push(`/tasks/${result.data.taskId}`);
      } catch {
        // It may or may not have been saved; submitting again reuses the same ID, so it can't be saved twice.
        setFormError("Couldn’t reach Solas. Check that it’s running, then submit again.");
      }
    });
  }

  const errorFor = (field: keyof Values) => errors[field]?.[0];

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} className="flex max-w-2xl flex-col gap-6">
      <Field
        id={fieldId("agentId")}
        label="Agent"
        required
        error={errorFor("agentId")}
        hint={
          selected ? (
            <>
              Runs with {selected.name}’s saved instructions on {selected.modelLabel}.{" "}
              {selected.tools.length > 0 ? `Tools: ${selected.tools.join(", ")}.` : "No tools: it can only write a reply."}
            </>
          ) : (
            "The agent works with its saved instructions, model, and tool permissions."
          )
        }
      >
        <Select
          name="agentId"
          {...fieldAria(fieldId("agentId"), { hint: true, error: errorFor("agentId") })}
          value={values.agentId}
          onChange={(event) => setField("agentId", event.target.value)}
          required
        >
          <option value="" disabled>
            Choose an agent
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.role ? `${agent.name} — ${agent.role}` : agent.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={fieldId("title")}
        label="Title"
        required
        error={errorFor("title")}
        aside={<CharacterCount value={values.title} max={TASK_LIMITS.title} />}
      >
        <Input
          name="title"
          {...fieldAria(fieldId("title"), { error: errorFor("title") })}
          value={values.title}
          onChange={(event) => setField("title", event.target.value)}
          maxLength={TASK_LIMITS.title}
          autoComplete="off"
          placeholder="Research AI agent architectures"
          required
        />
      </Field>

      <Field
        id={fieldId("instructions")}
        label="Instructions"
        required
        hint="What to do, and what a good result looks like. The agent can’t ask you questions while it works."
        error={errorFor("instructions")}
        aside={<CharacterCount value={values.instructions} max={TASK_LIMITS.instructions} />}
      >
        <Textarea
          name="instructions"
          {...fieldAria(fieldId("instructions"), { hint: true, error: errorFor("instructions") })}
          value={values.instructions}
          onChange={(event) => setField("instructions", event.target.value)}
          maxLength={TASK_LIMITS.instructions}
          rows={10}
          className="min-h-40 text-reading"
          required
        />
      </Field>

      {formError && (
        <Callout tone="danger" role="alert">
          {formError}
        </Callout>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <p className="mr-auto text-sm text-subtle">It keeps running if you close Solas.</p>
        <Link href="/tasks" className={buttonClassName({ variant: "secondary" })}>
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending || submitted}>
          {pending || submitted ? "Creating…" : "Create task"}
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

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useLayoutEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { createAgent, updateAgent } from "@/app/(app)/agents/actions";
import { buttonClassName, Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldAria } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  AGENT_LIMITS,
  createAgentSchema,
  updateAgentSchema,
  validateAgentInput,
  type AgentToolSetting,
  type FieldErrors,
} from "@/lib/agents/validation";
import type { Agent } from "@/server/agents/service";
import type { ProviderDefinition } from "@/server/providers/registry";
import type { ToolCatalogEntry } from "@/server/tools/types";
import { DelegationFields, type DelegationOption } from "./delegation-fields";
import { ToolPermissionsFields } from "./tool-permissions-fields";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";

type AgentFormProps = {
  providers: readonly ProviderDefinition[];
  /** Every tool Solas has, as plain data. */
  tools: ToolCatalogEntry[];
  /** Where the agent's workspace is (edit) or will be (create), for display. */
  workspacePath: string;
  /** The other agents, which this one could delegate to. */
  delegationOptions: DelegationOption[];
} & (
  | { mode: "create"; agent?: undefined; toolSettings?: undefined; delegateTo?: undefined }
  | { mode: "edit"; agent: Agent; toolSettings: AgentToolSetting[]; delegateTo: string[] }
);

/** What the inputs hold. Selects use "" for "not configured". */
type FormValues = {
  name: string;
  role: string;
  description: string;
  instructions: string;
  providerId: string;
  modelId: string;
  enabled: boolean;
  /** Enabled tools only, kept in catalog order so comparisons are stable. */
  tools: AgentToolSetting[];
  /** The delegation switch; turning it off clears the targets when saved. */
  delegationOn: boolean;
  /** Chosen delegation targets, in list order. */
  delegateTo: string[];
};

const EMPTY_VALUES: FormValues = {
  name: "",
  role: "",
  description: "",
  instructions: "",
  providerId: "",
  modelId: "",
  enabled: true,
  tools: [],
  delegationOn: false,
  delegateTo: [],
};

// Error focus order follows the form's visual order.
const FIELD_ORDER = ["name", "role", "description", "instructions", "providerId", "modelId", "tools", "delegateTo"] as const;

function valuesFromAgent(agent: Agent, tools: AgentToolSetting[], delegateTo: string[]): FormValues {
  return {
    name: agent.name,
    role: agent.role,
    description: agent.description,
    instructions: agent.instructions,
    providerId: agent.providerId ?? "",
    modelId: agent.modelId ?? "",
    enabled: agent.enabled,
    tools,
    delegationOn: delegateTo.length > 0,
    delegateTo,
  };
}

/** Form values → the shape the backend accepts. */
function toInput(values: FormValues) {
  return {
    name: values.name,
    role: values.role,
    description: values.description,
    instructions: values.instructions,
    providerId: values.providerId || null,
    modelId: values.modelId || null,
    enabled: values.enabled,
    tools: values.tools,
    delegateTo: values.delegationOn ? values.delegateTo : [],
  };
}

type AgentInput = ReturnType<typeof toInput>;

/** Only the fields that differ, so an edit never rewrites what you didn't touch. */
function changedFields(next: AgentInput, initial: AgentInput): Partial<AgentInput> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(initial[key as keyof AgentInput]),
    ),
  );
}

/**
 * The Agent Builder form, used for both creating and editing an agent.
 *
 * Flow on submit: validate in the browser with the same Zod schemas the server
 * uses (instant feedback) → call a Server Action → the server validates again
 * and saves → on success, go to the agent's page; on failure, show the
 * server's field errors next to the inputs.
 */
export function AgentForm({
  mode,
  agent,
  providers,
  tools,
  toolSettings,
  workspacePath,
  delegationOptions,
  delegateTo,
}: AgentFormProps) {
  const router = useRouter();
  // Unique per form instance: Next.js keeps recently visited pages mounted
  // (hidden) for instant back navigation, so fixed ids could appear twice.
  const idPrefix = useId();
  const fieldId = (field: string) => `${idPrefix}-${field}`;
  const [initial] = useState<FormValues>(() =>
    agent ? valuesFromAgent(agent, toolSettings ?? [], delegateTo ?? []) : EMPTY_VALUES,
  );
  const [values, setValues] = useState<FormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // Next.js keeps visited pages mounted but hidden (React Activity), so this
  // form would otherwise come back with an old draft or "saved" state. The
  // cleanup runs when the page is hidden: the next visit starts fresh.
  useLayoutEffect(() => {
    return () => {
      setValues(initial);
      setErrors({});
      setFormError(null);
      setSaved(false);
    };
  }, [initial]);

  const changes = changedFields(toInput(values), toInput(initial));
  // Turning delegation on counts as a change even before a target is chosen, so Save explains what's missing.
  const dirty = Object.keys(changes).length > 0 || values.delegationOn !== initial.delegationOn;
  useUnsavedChangesGuard(dirty && !saved);

  function setField<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    // Editing a field clears its message; the next submit re-checks everything.
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function showErrors(fieldErrors: FieldErrors, message: string | null) {
    setErrors(fieldErrors);
    setFormError(message);
    const first = FIELD_ORDER.find((field) => fieldErrors[field]?.length);
    // After React renders the messages, so screen readers hear the error too.
    if (first) requestAnimationFrame(() => document.getElementById(fieldId(first))?.focus());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    if (values.delegationOn && values.delegateTo.length === 0) {
      showErrors({ delegateTo: ["Choose at least one agent, or turn delegation off."] }, null);
      return;
    }
    const input = mode === "create" ? toInput(values) : changes;
    const check = validateAgentInput(mode === "create" ? createAgentSchema : updateAgentSchema, input);
    if (!check.ok) {
      showErrors(check.fieldErrors, Object.keys(check.fieldErrors).length ? null : (check.formError ?? null));
      return;
    }

    setErrors({});
    setFormError(null);
    startTransition(async () => {
      const result = mode === "create" ? await createAgent(input) : await updateAgent(agent.id, input);
      if (!result.ok) {
        const hasFieldErrors = Object.values(result.error.fieldErrors).some((list) => list?.length);
        showErrors(result.error.fieldErrors, hasFieldErrors ? null : result.error.message);
        return;
      }
      setSaved(true);
      toast.success(mode === "create" ? `Created “${result.data.name}”.` : "Changes saved.");
      router.push(`/agents/${result.data.id}`);
    });
  }

  const cancelHref = mode === "create" ? "/agents" : `/agents/${agent.id}`;
  const errorFor = (field: keyof FormValues) => errors[field]?.[0];

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} className="divide-y divide-border">
      <FormSection title="Identity" description="Who the agent is and what it’s for.">
        <Field id={fieldId("name")} label="Name" required error={errorFor("name")}>
          <Input
            name="name"
            {...fieldAria(fieldId("name"), { error: errorFor("name") })}
            value={values.name}
            onChange={(event) => setField("name", event.target.value)}
            maxLength={AGENT_LIMITS.name}
            autoComplete="off"
            placeholder="Research Assistant"
            required
          />
        </Field>
        <Field
          id={fieldId("role")}
          label="Role"
          required
          hint="A short label for its job, like “research” or “weekly reports”."
          error={errorFor("role")}
        >
          <Input
            name="role"
            {...fieldAria(fieldId("role"), { hint: true, error: errorFor("role") })}
            value={values.role}
            onChange={(event) => setField("role", event.target.value)}
            maxLength={AGENT_LIMITS.role}
            autoComplete="off"
            placeholder="research"
            required
          />
        </Field>
        <Field
          id={fieldId("description")}
          label="Description"
          hint="Shown in your agent list."
          error={errorFor("description")}
          aside={<CharacterCount value={values.description} max={AGENT_LIMITS.description} />}
        >
          <Textarea
            name="description"
            {...fieldAria(fieldId("description"), { hint: true, error: errorFor("description") })}
            value={values.description}
            onChange={(event) => setField("description", event.target.value)}
            maxLength={AGENT_LIMITS.description}
            rows={3}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Instructions"
        description="What the agent should do and how. These become its system instructions, which it follows in every task."
      >
        <Field
          id={fieldId("instructions")}
          label="System instructions"
          required
          hint="Describe its goal, how it should approach the work, and what a good result looks like. Plain language works best."
          error={errorFor("instructions")}
          aside={<CharacterCount value={values.instructions} max={AGENT_LIMITS.instructions} />}
        >
          <Textarea
            name="instructions"
            {...fieldAria(fieldId("instructions"), { hint: true, error: errorFor("instructions") })}
            value={values.instructions}
            onChange={(event) => setField("instructions", event.target.value)}
            maxLength={AGENT_LIMITS.instructions}
            rows={12}
            className="min-h-48 text-reading"
            required
          />
        </Field>
      </FormSection>

      <FormSection
        title="AI model"
        description="Needed to chat. Claude runs through your own Claude Code sign-in on this computer."
      >
        <ModelFields
          providers={providers}
          values={values}
          errors={errors}
          fieldId={fieldId}
          onChange={(providerId, modelId) => {
            setField("providerId", providerId);
            setField("modelId", modelId);
          }}
        />
      </FormSection>

      <FormSection
        title="Tools & permissions"
        description="What the agent may do beyond replying. Every tool is off until you turn it on, and Solas checks these permissions on every call."
      >
        <ToolPermissionsFields
          catalog={tools}
          value={values.tools}
          onChange={(next) => setField("tools", next)}
          error={errorFor("tools")}
          errorId={fieldId("tools")}
          workspacePath={workspacePath}
        />
      </FormSection>

      <FormSection
        title="Delegation"
        description="Whether this agent may hand a subtask to another agent in a task, and to which ones. Off until you choose."
      >
        <DelegationFields
          options={delegationOptions}
          on={values.delegationOn}
          value={values.delegateTo}
          onToggle={(on) => {
            setField("delegationOn", on);
            if (errors.delegateTo) setErrors((current) => ({ ...current, delegateTo: undefined }));
          }}
          onChange={(next) => setField("delegateTo", next)}
          error={errorFor("delegateTo")}
          errorId={fieldId("delegateTo")}
        />
      </FormSection>

      <FormSection title="Status" description="Whether the agent is available. This is a setting, not a run state.">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3.5">
          <div className="min-w-0">
            <p id={fieldId("enabled-label")} className="font-medium">
              Enabled
            </p>
            <p id={fieldId("enabled-hint")} className="mt-0.5 text-sm text-muted">
              Only enabled agents answer messages. You can change this at any time.
            </p>
          </div>
          <Switch
            checked={values.enabled}
            onCheckedChange={(checked) => setField("enabled", checked)}
            aria-labelledby={fieldId("enabled-label")}
            aria-describedby={fieldId("enabled-hint")}
            className="mt-0.5"
          />
        </div>
      </FormSection>

      {/* Sticky so the save button stays reachable below long instructions. */}
      <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-background px-4 py-3 md:-mx-10 md:px-10">
        {formError && (
          <Callout tone="danger" role="alert" className="mb-3">
            {formError}
          </Callout>
        )}
        <div className="flex items-center justify-end gap-2">
          <p className="mr-auto text-sm text-subtle" aria-live="polite">
            {dirty && !saved ? "Unsaved changes" : ""}
          </p>
          <Link href={cancelHref} className={buttonClassName({ variant: "secondary" })}>
            Cancel
          </Link>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || (mode === "edit" && !dirty)}
            aria-disabled={pending || undefined}
          >
            {pending
              ? mode === "create"
                ? "Creating…"
                : "Saving…"
              : mode === "create"
                ? "Create agent"
                : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Provider and model pickers, limited to what the backend can actually run.
 * Today no provider is available, so the agent is saved "not configured" and
 * the form says so instead of offering choices that don't work.
 */
function ModelFields({
  providers,
  values,
  errors,
  fieldId,
  onChange,
}: {
  providers: readonly ProviderDefinition[];
  values: FormValues;
  errors: FieldErrors;
  fieldId: (field: string) => string;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const available = providers.filter((provider) => provider.status === "available");

  if (available.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
          <div className="bg-surface px-4 py-3">
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="mt-0.5 text-sm font-medium">Not configured</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="text-xs text-subtle">Model</dt>
            <dd className="mt-0.5 text-sm font-medium">Not configured</dd>
          </div>
        </dl>
        <Callout>
          No AI provider is available in this build of Solas, so agents are saved without a model.
        </Callout>
      </div>
    );
  }

  const provider = available.find((candidate) => candidate.id === values.providerId);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={fieldId("providerId")} label="Provider" error={errors.providerId?.[0]}>
        <Select
          name="providerId"
          {...fieldAria(fieldId("providerId"), { error: errors.providerId?.[0] })}
          value={values.providerId}
          onChange={(event) => onChange(event.target.value, "")}
        >
          <option value="">Not configured</option>
          {available.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={fieldId("modelId")} label="Model" error={errors.modelId?.[0]}>
        <Select
          name="modelId"
          {...fieldAria(fieldId("modelId"), { error: errors.modelId?.[0] })}
          value={values.modelId}
          disabled={!provider}
          onChange={(event) => onChange(values.providerId, event.target.value)}
        >
          <option value="">{provider ? "Choose a model" : "Choose a provider first"}</option>
          {provider?.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function FormSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 py-8 first:pt-0 lg:grid-cols-[14rem_1fr] lg:gap-10">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
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

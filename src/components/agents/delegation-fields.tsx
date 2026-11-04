"use client";

import { useId } from "react";
import { AlertIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

/** Another agent this one could delegate to, as plain data. */
export type DelegationOption = { id: string; name: string; role: string; enabled: boolean };

type DelegationFieldsProps = {
  options: DelegationOption[];
  on: boolean;
  /** Chosen agent IDs. */
  value: string[];
  onToggle: (on: boolean) => void;
  onChange: (next: string[]) => void;
  error?: string;
  /** Focus target for errors (the form moves focus here). */
  errorId: string;
};

/**
 * Whether this agent may hand subtasks to other agents, and to which ones.
 * Off by default. What's saved is checked again by the server, and the
 * worker checks it on every delegation; the delegated agent then works with
 * its own instructions and tools, never this agent's.
 */
export function DelegationFields({ options, on, value, onToggle, onChange, error, errorId }: DelegationFieldsProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;

  function toggle(id: string, checked: boolean) {
    const next = checked ? [...value, id] : value.filter((existing) => existing !== id);
    // Keep the list's order, so an unchanged selection compares equal.
    onChange(options.map((option) => option.id).filter((optionId) => next.includes(optionId)));
  }

  return (
    <fieldset id={errorId} tabIndex={-1} aria-describedby={error ? `${errorId}-error` : undefined} className="flex flex-col gap-3 focus:outline-none">
      <legend className="sr-only">Delegation</legend>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3.5">
        <div className="min-w-0">
          <p id={labelId} className="font-medium">
            Can delegate tasks
          </p>
          <p id={hintId} className="mt-0.5 text-sm text-muted">
            In a task, this agent may hand one subtask to an agent you choose below. That agent works as itself, with
            its own tools and approvals. Delegated tasks can’t delegate again.
          </p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={onToggle}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          className="mt-0.5"
          disabled={options.length === 0}
        />
      </div>

      {options.length === 0 && <p className="text-sm text-muted">Create another agent first; then it can be chosen here.</p>}

      {on && options.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">May delegate to</p>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {options.map((option) => {
              const id = `${baseId}-${option.id}`;
              return (
                <li key={option.id}>
                  <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-hover/60">
                    <input
                      id={id}
                      type="checkbox"
                      checked={value.includes(option.id)}
                      onChange={(event) => toggle(option.id, event.target.checked)}
                      className="size-4 shrink-0 cursor-pointer accent-accent"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{option.name}</span>
                      {option.role && <span className="ml-2 text-sm text-muted">{option.role}</span>}
                    </span>
                    {!option.enabled && <Badge>Disabled</Badge>}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-sm text-muted">A disabled agent can be chosen, but receives nothing until it’s enabled.</p>
        </div>
      )}

      {error && (
        <p id={`${errorId}-error`} className="flex items-start gap-1.5 text-sm text-danger">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </fieldset>
  );
}

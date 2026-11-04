"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { setTeamDelegation } from "@/app/(app)/teams/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { TeamMemberView } from "@/server/teams/service";

/**
 * Who in this team may delegate to whom. Each row is one member's M5A
 * delegation targets, limited to this team; targets outside the team are
 * shown but changed only in the agent's own settings. The backend checks
 * these permissions on every delegation; the team itself grants nothing.
 */
export function TeamDelegation({ teamId, members }: { teamId: string; members: TeamMemberView[] }) {
  if (members.length < 2) {
    return <p className="text-sm text-muted">Delegation inside a team needs at least two members.</p>;
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {members.map((member) => (
        <DelegationRow key={member.id} teamId={teamId} member={member} others={members.filter((other) => other.id !== member.id)} />
      ))}
    </ul>
  );
}

function DelegationRow({ teamId, member, others }: { teamId: string; member: TeamMemberView; others: TeamMemberView[] }) {
  const router = useRouter();
  const baseId = useId();
  const inTeam = member.delegatesTo.filter((target) => target.inTeam);
  const outside = member.delegatesTo.filter((target) => !target.inTeam);
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<string[]>(inTeam.map((target) => target.id));
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        const result = await setTeamDelegation(teamId, { agentId: member.id, targetIds: chosen });
        if (!result.ok) {
          toast.error(result.error.message);
          return;
        }
        toast.success(chosen.length > 0 ? `${member.name}’s delegation saved.` : `${member.name} no longer delegates in this team.`);
        setEditing(false);
        router.refresh();
      } catch {
        toast.error("Couldn’t reach Solas. Try again.");
      }
    });
  }

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-medium">{member.name}</p>
          <p className="mt-0.5 text-sm text-muted">
            {inTeam.length > 0 ? (
              <>May delegate to {inTeam.map((target) => target.name).join(", ")}</>
            ) : (
              "Doesn’t delegate in this team"
            )}
            {outside.length > 0 && (
              <>
                {" "}· also {outside.length} outside this team (
                <Link href={`/agents/${member.id}/edit`} className="underline underline-offset-2">
                  agent settings
                </Link>
                )
              </>
            )}
          </p>
        </div>
        {!editing && (
          <Button size="sm" onClick={() => setEditing(true)} aria-label={`Edit delegation for ${member.name}`}>
            Edit
          </Button>
        )}
      </div>
      {editing && (
        <fieldset className="mt-3">
          <legend className="mb-2 text-sm text-muted">{member.name} may delegate to:</legend>
          <div className="flex flex-col gap-2">
            {others.map((other) => {
              const id = `${baseId}-${other.id}`;
              return (
                <label key={other.id} htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 cursor-pointer accent-accent"
                    checked={chosen.includes(other.id)}
                    onChange={(event) =>
                      setChosen((current) =>
                        event.target.checked ? [...current, other.id] : current.filter((existing) => existing !== other.id),
                      )
                    }
                  />
                  <span>
                    {other.name}
                    {other.readiness !== "ready" && (
                      <span className="ml-1.5 text-subtle">
                        ({other.readiness === "disabled" ? "disabled: receives nothing until enabled" : "no model yet"})
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setChosen(inTeam.map((target) => target.id));
                setEditing(false);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
    </li>
  );
}

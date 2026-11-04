import Link from "next/link";
import { RelativeTime } from "@/components/ui/relative-time";
import { formatInTimeZone } from "@/lib/automations/schedule";
import type { AutomationSummary } from "@/server/automations/service";
import { AutomationStateBadge, OccurrenceBadge } from "./automation-badges";

/**
 * Every automation with what matters at a glance: its state, agent,
 * schedule, next run, and how the last run went. Soonest next run first;
 * paused and finished ones after.
 */
export function AutomationList({ automations }: { automations: AutomationSummary[] }) {
  const active = automations.filter((automation) => automation.state === "active").length;
  const paused = automations.filter((automation) => automation.state === "paused").length;
  const missed = automations.filter((automation) => automation.state === "missed").length;

  return (
    <section aria-label="Automations">
      <p className="mb-3 flex flex-wrap gap-x-3 text-sm text-subtle tabular-nums">
        <span>{active} active</span>
        <span>{paused} paused</span>
        {missed > 0 && <span className="text-foreground">{missed} missed, needs you</span>}
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {automations.map((automation) => (
          <li key={automation.id} className="relative px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <Link
                href={`/automations/${automation.id}`}
                className="min-w-0 truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
              >
                {automation.name}
              </Link>
              <AutomationStateBadge state={automation.state} />
            </div>
            {automation.description && (
              <p className="mt-0.5 line-clamp-2 text-sm text-muted md:line-clamp-1">{automation.description}</p>
            )}
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-subtle">
              <span>{automation.agent.name}</span>
              <span>
                {automation.scheduleText} · {automation.timeZone.replaceAll("_", " ")}
              </span>
              <span className="tabular-nums">
                {automation.nextRunAt ? (
                  <>
                    Next: {formatInTimeZone(automation.nextRunAt, automation.timeZone)} (
                    <RelativeTime date={automation.nextRunAt} />)
                  </>
                ) : (
                  NO_NEXT_RUN[automation.state]
                )}
              </span>
            </p>
            {automation.lastOccurrence && (
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                <span>Last run</span>
                <OccurrenceBadge occurrence={automation.lastOccurrence} />
                <span className="tabular-nums">
                  <RelativeTime date={automation.lastOccurrence.scheduledFor} />
                </span>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const NO_NEXT_RUN: Record<AutomationSummary["state"], string> = {
  active: "Next: —",
  paused: "Paused: no runs scheduled",
  finished: "Ran once; nothing more scheduled",
  missed: "Its one-time run was missed",
};

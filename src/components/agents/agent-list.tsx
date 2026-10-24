"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RelativeTime } from "@/components/ui/relative-time";
import { isTypingTarget } from "@/lib/keyboard";
import type { Agent } from "@/server/agents/service";
import { AgentActionsMenu } from "./agent-actions-menu";
import { AgentStatusBadge } from "./agent-status-badge";

export type AgentListEntry = Agent & {
  /** "Provider · Model", or null when no model is configured. */
  modelLabel: string | null;
};

/**
 * The searchable list of stored agents. The server loads every agent; search
 * filters them here, instantly, because one owner has a handful of agents,
 * not thousands. (If that changes, search moves to the database.)
 */
export function AgentList({ agents }: { agents: AgentListEntry[] }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to the search field, unless you're already typing somewhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? agents.filter((agent) =>
        [agent.name, agent.role, agent.description].some((text) => text.toLowerCase().includes(needle)),
      )
    : agents;

  const countLabel = needle
    ? `${visible.length} of ${agents.length} ${agents.length === 1 ? "agent" : "agents"}`
    : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;

  return (
    <section aria-label="Agents">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search agents"
            aria-keyshortcuts="/"
            placeholder="Search agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            className="pr-9 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
          />
          <Kbd className="absolute top-1/2 right-2 -translate-y-1/2 max-sm:hidden">/</Kbd>
        </div>
        <p aria-live="polite" className="text-sm text-subtle tabular-nums">
          {countLabel}
        </p>
      </div>

      {visible.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {visible.map((agent) => (
            <AgentListItem key={agent.id} agent={agent} />
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
          <p className="font-medium">No agents match “{query.trim()}”</p>
          <p className="mt-1 text-sm text-muted">Search looks at names, roles, and descriptions.</p>
          <Button size="sm" className="mt-4" onClick={() => setQuery("")}>
            Clear search
          </Button>
        </div>
      )}
    </section>
  );
}

function AgentListItem({ agent }: { agent: AgentListEntry }) {
  const meta = (
    <>
      <span className={agent.modelLabel ? "text-muted" : undefined}>{agent.modelLabel ?? "No model"}</span>
      <AgentStatusBadge enabled={agent.enabled} />
      <span className="whitespace-nowrap tabular-nums">
        Updated <RelativeTime date={agent.updatedAt} />
      </span>
    </>
  );

  return (
    <li className="relative flex items-start gap-3 px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {/* The ::after overlay makes the whole row clickable; the menu sits above it. */}
          <Link
            href={`/agents/${agent.id}`}
            className="truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
          >
            {agent.name}
          </Link>
          {agent.role && <span className="truncate text-sm text-muted">{agent.role}</span>}
        </div>
        {agent.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted md:line-clamp-1">{agent.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-subtle md:hidden">{meta}</div>
      </div>
      <div className="hidden shrink-0 items-center gap-4 self-center text-xs text-subtle md:flex">{meta}</div>
      <div className="relative z-10 -my-1 shrink-0 self-center">
        <AgentActionsMenu agent={agent} />
      </div>
    </li>
  );
}

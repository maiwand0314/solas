import Link from "next/link";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConversationSummary } from "@/server/conversations/service";

/** Saved conversations, most recent first. A Server Component: no client code. */
export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  return (
    <ul
      aria-label="Conversations"
      className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface"
    >
      {conversations.map((conversation) => (
        <li
          key={conversation.id}
          className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60"
        >
          <div className="min-w-0 flex-1">
            {/* The ::after overlay makes the whole row clickable. */}
            <Link
              href={`/conversations/${conversation.id}`}
              className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
            >
              {conversation.title}
            </Link>
            <p className="mt-0.5 truncate text-sm text-muted">{conversation.agentName}</p>
          </div>
          <span className="shrink-0 text-xs whitespace-nowrap text-subtle tabular-nums">
            <RelativeTime date={conversation.updatedAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConversationListSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading conversations…</span>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-4">
            <div className="flex-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3.5 w-1/4" />
            </div>
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <div role="status" aria-busy="true" className="mx-auto w-full max-w-[720px]">
      <span className="sr-only">Loading conversation…</span>
      <Skeleton className="mb-8 h-6 w-64" />
      <Skeleton className="ml-auto h-12 w-2/3" />
      <Skeleton className="mt-6 h-24 w-full" />
    </div>
  );
}

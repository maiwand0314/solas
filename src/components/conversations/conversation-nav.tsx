"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/cn";

export type ConversationNavItem = {
  id: string;
  title: string;
  agentName: string;
  updatedAt: Date;
};

/**
 * The list of conversations beside an open conversation (desktop). The
 * current one is highlighted; reading the path suspends under Cache
 * Components, so the fallback is the same list without a highlight.
 */
export function ConversationNav({ conversations }: { conversations: ConversationNavItem[] }) {
  return (
    <Suspense fallback={<NavList conversations={conversations} pathname={null} />}>
      <CurrentNavList conversations={conversations} />
    </Suspense>
  );
}

function CurrentNavList({ conversations }: { conversations: ConversationNavItem[] }) {
  return <NavList conversations={conversations} pathname={usePathname()} />;
}

function NavList({ conversations, pathname }: { conversations: ConversationNavItem[]; pathname: string | null }) {
  if (conversations.length === 0) {
    return <p className="px-2 py-1.5 text-sm text-subtle">No conversations yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {conversations.map((conversation) => {
        const href = `/conversations/${conversation.id}`;
        const current = pathname === href;
        return (
          <li key={conversation.id}>
            <Link
              href={href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "block rounded-md px-2.5 py-2 transition-colors duration-100",
                current ? "bg-surface-hover" : "hover:bg-surface-hover/60",
              )}
            >
              <span className={cn("block truncate text-sm", current ? "font-medium text-foreground" : "text-foreground")}>
                {conversation.title}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-subtle">
                <span className="truncate">{conversation.agentName}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">
                  <RelativeTime date={conversation.updatedAt} />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

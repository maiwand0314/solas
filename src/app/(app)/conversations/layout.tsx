import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ConversationNav } from "@/components/conversations/conversation-nav";
import { PlusIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listConversationsForOwner } from "@/server/conversations/queries";

/**
 * Conversations get two panes on wide screens: the list on the left and the
 * open conversation on the right, so moving between conversations is one
 * click. On narrow screens the list is its own page (/conversations).
 */
export default function ConversationsLayout({ children }: LayoutProps<"/conversations">) {
  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:block">
        {/* Sticky below the 48px top bar, scrolling on its own when long. */}
        <div className="sticky top-[4.5rem] flex max-h-[calc(100dvh-6rem)] flex-col">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Conversations</h2>
            <Link href="/conversations/new" className={buttonClassName({ size: "sm" })}>
              <PlusIcon className="size-3.5" />
              New
            </Link>
          </div>
          <nav aria-label="Conversations" className="-mx-1 min-h-0 overflow-y-auto px-1 pb-4">
            <Suspense fallback={<NavSkeleton />}>
              <StoredConversationNav />
            </Suspense>
          </nav>
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

async function StoredConversationNav() {
  let conversations;
  try {
    conversations = await listConversationsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    // The page itself shows the full error; the side list stays quiet.
    return <p className="px-2 text-sm text-subtle">Couldn’t load conversations.</p>;
  }
  return <ConversationNav conversations={conversations} />;
}

function NavSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-2.5 py-2" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row}>
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="mt-1.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

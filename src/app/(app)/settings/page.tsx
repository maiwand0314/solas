import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { LoadError } from "@/components/load-error";
import { NotificationPreferences } from "@/components/notifications/notification-preferences";
import { ThemeCards } from "@/components/preferences/theme-selector";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkerStatusPanel } from "@/components/workers/worker-status-panel";
import { listNotificationPreferencesForOwner } from "@/server/notifications/queries";
import { WORKER_HEALTH } from "@/server/workers/limits";
import { getWorkerStatusForOwner } from "@/server/workers/queries";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Preferences for your Solas workspace." />

      <div className="divide-y divide-border">
        <SettingsSection
          title="Appearance"
          description="Choose how Solas looks. System follows your operating system. Saved in this browser."
        >
          <ThemeCards />
        </SettingsSection>

        <SettingsSection
          id="worker"
          title="Worker"
          description="The background process that runs agents, tasks, and automations. Read from what it reports to the database."
        >
          <Suspense fallback={<SectionSkeleton />}>
            <WorkerStatus />
          </Suspense>
        </SettingsSection>

        <SettingsSection
          id="notifications"
          title="Notifications"
          description="Which events create a notification in your inbox. Turning one off affects only new events; nothing already in the inbox changes."
        >
          <Suspense fallback={<SectionSkeleton />}>
            <Preferences />
          </Suspense>
        </SettingsSection>

        <SettingsSection
          title="Agent runtime"
          description="How agents reach their AI model."
        >
          <NotYetAvailable>
            Agents will run through Claude Code on this computer, signed in with your own account.
            Solas never stores your Claude credentials.
          </NotYetAvailable>
        </SettingsSection>

        <SettingsSection
          title="Account and security"
          description="Sign-in, sessions, and access to your workspace."
        >
          <NotYetAvailable>
            Solas runs locally without sign-in for now. Sign-in is added before Solas is ever
            reachable from another device.
          </NotYetAvailable>
        </SettingsSection>
      </div>
    </>
  );
}

async function WorkerStatus() {
  const status = await getWorkerStatusForOwner();
  return (
    <WorkerStatusPanel
      status={status}
      limits={{
        heartbeatSeconds: WORKER_HEALTH.heartbeatIntervalMs / 1000,
        staleSeconds: WORKER_HEALTH.staleAfterMs / 1000,
        overdueMinutes: WORKER_HEALTH.stepOverdueAfterMs / 60_000,
      }}
    />
  );
}

async function Preferences() {
  let preferences;
  try {
    preferences = await listNotificationPreferencesForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="notifications" />;
  }
  return <NotificationPreferences preferences={preferences} />;
}

function SectionSkeleton() {
  return <Skeleton className="h-28 w-full" />;
}

function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className="grid scroll-mt-16 gap-4 py-8 first:pt-0 lg:grid-cols-[16rem_1fr] lg:gap-10">
      <div>
        <h2 id={headingId} className="font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function NotYetAvailable({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 sm:flex-row sm:justify-between sm:gap-4">
      <p className="text-muted">{children}</p>
      <Badge>Not yet available</Badge>
    </div>
  );
}

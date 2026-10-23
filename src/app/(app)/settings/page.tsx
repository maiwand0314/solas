import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeCards } from "@/components/preferences/theme-selector";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

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

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 py-8 first:pt-0 lg:grid-cols-[16rem_1fr] lg:gap-10">
      <div>
        <h2 className="font-semibold">{title}</h2>
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

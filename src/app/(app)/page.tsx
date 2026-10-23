import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Overview",
};

type Capability = {
  name: string;
  description: string;
  available: boolean;
};

// What Solas can actually do today. Update this as milestones ship; it should
// never claim more than what works.
const capabilities: Capability[] = [
  {
    name: "Navigation and themes",
    description: "Move between sections, search with ⌘K, and choose a light, dark, or system theme.",
    available: true,
  },
  {
    name: "Agents",
    description: "Create agents with a role, instructions, a model, and the tools they may use.",
    available: false,
  },
  {
    name: "Conversations",
    description: "Talk with an agent. Replies keep running after you close the browser.",
    available: false,
  },
  {
    name: "Tasks",
    description: "Hand an agent a piece of work and review the result when it’s done.",
    available: false,
  },
  {
    name: "Approvals",
    description: "Agents ask before doing anything sensitive, and wait for your decision.",
    available: false,
  },
  {
    name: "Automations",
    description: "Run agent tasks on a schedule.",
    available: false,
  },
];

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Your private workspace for a team of AI agents: configure them, talk to them, and hand them work."
      />

      <section aria-labelledby="capabilities-heading">
        <div className="mb-3 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="capabilities-heading" className="text-sm font-semibold">
            Capabilities
          </h2>
          <p className="text-xs text-subtle">Solas is built in stages. This list shows what works today.</p>
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {capabilities.map((capability) => (
            <li key={capability.name} className="flex items-start justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="font-medium">{capability.name}</p>
                <p className="mt-0.5 text-muted">{capability.description}</p>
              </div>
              {capability.available ? (
                <Badge tone="success">Available</Badge>
              ) : (
                <Badge>Planned</Badge>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

import Link from "next/link";
import { AutomationsIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AutomationNotFound() {
  return (
    <EmptyState icon={AutomationsIcon} title="Automation not found" description="It may have been deleted.">
      <Link href="/automations" className={buttonClassName()}>
        All automations
      </Link>
    </EmptyState>
  );
}

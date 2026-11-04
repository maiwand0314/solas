import Link from "next/link";
import { TeamsIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function TeamNotFound() {
  return (
    <EmptyState icon={TeamsIcon} title="Team not found" description="It may have been deleted.">
      <Link href="/teams" className={buttonClassName()}>
        All teams
      </Link>
    </EmptyState>
  );
}

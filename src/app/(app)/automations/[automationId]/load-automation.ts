import "server-only";
import { notFound, unstable_rethrow } from "next/navigation";
import { AutomationServiceError } from "@/server/automations/errors";
import { getAutomationForOwner } from "@/server/automations/queries";
import type { AutomationDetail } from "@/server/automations/service";

/** Loads one automation for a page: a missing one or a bad ID shows not-found; other failures are returned. */
export async function loadAutomation(id: string): Promise<{ detail: AutomationDetail } | { error: unknown }> {
  try {
    return { detail: await getAutomationForOwner(id) };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AutomationServiceError && (error.code === "not_found" || error.code === "validation_failed")) {
      notFound();
    }
    return { error };
  }
}

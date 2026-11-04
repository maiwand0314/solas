import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getAutomationService, type AutomationDetail, type AutomationSummary } from "./service";

// Reads for Server Components. Each one checks the owner first, so a page
// can't forget to: pages import these, never the raw service.

export async function listAutomationsForOwner(): Promise<AutomationSummary[]> {
  await requireOwner();
  return getAutomationService().list();
}

export async function getAutomationForOwner(id: unknown): Promise<AutomationDetail> {
  await requireOwner();
  return getAutomationService().get(id);
}

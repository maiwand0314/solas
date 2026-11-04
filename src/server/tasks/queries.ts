import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getTaskService, type TaskDetail, type TaskListQuery, type TaskSummary } from "./service";

// Reads for Server Components. Each one checks the owner first, so a page
// can't forget to: pages import these, never the raw service.

export async function listTasksForOwner(query: TaskListQuery) {
  await requireOwner();
  const service = getTaskService();
  const [tasks, counts] = await Promise.all([service.list(query), service.countByFilter(query.search, query.teamId)]);
  return { tasks, counts } satisfies { tasks: TaskSummary[]; counts: Record<string, number> };
}

export async function getTaskForOwner(id: unknown): Promise<TaskDetail> {
  await requireOwner();
  return getTaskService().get(id);
}

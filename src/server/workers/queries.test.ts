import { describe, expect, it, vi } from "vitest";

// The owner-guarded read: a database that can't be read is the status
// "unavailable", not a crashed page, and the owner check still comes first.

const requireOwner = vi.fn(async () => {});
vi.mock("@/server/auth/owner", () => ({ requireOwner: () => requireOwner() }));
vi.mock("@/server/logger", () => ({ jsonLogger: () => {}, truncate: (s: string) => s }));
vi.mock("./status", () => ({
  getWorkerStatusService: () => ({ read: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) }),
}));

const { getWorkerStatusForOwner } = await import("./queries");

describe("getWorkerStatusForOwner", () => {
  it("reports 'unavailable' when the database can't be read", async () => {
    await expect(getWorkerStatusForOwner()).resolves.toEqual({ state: "unavailable" });
    expect(requireOwner).toHaveBeenCalled();
  });

  it("refuses anyone but the owner before reading anything", async () => {
    requireOwner.mockRejectedValueOnce(new Error("forbidden"));
    await expect(getWorkerStatusForOwner()).rejects.toThrow("forbidden");
  });
});

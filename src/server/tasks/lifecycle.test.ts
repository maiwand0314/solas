import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "@/server/db/schema";
import { allowedFrom, canTransition, decideAfterFailure, TASK_TRANSITIONS, type FailureFacts } from "./lifecycle";

// The task state machine and retry policy, as pure rules.

describe("task transitions", () => {
  it("defines every status, and only allows moves to known statuses", () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const target of targets) expect(TASK_STATUSES).toContain(target);
    }
  });

  it("never leaves completed: a finished task can't run again", () => {
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    for (const status of TASK_STATUSES) expect(canTransition("completed", status)).toBe(false);
  });

  it("only reaches completed from an attempt that is actually running", () => {
    expect(allowedFrom("completed").sort()).toEqual(["awaiting_approval", "running"]);
    expect(canTransition("queued", "completed")).toBe(false);
  });

  it("goes back to queued only by a retry: automatic from a running attempt, or the owner's from a stopped task", () => {
    expect(allowedFrom("queued").sort()).toEqual([
      "awaiting_approval",
      "cancelled",
      "failed",
      "interrupted",
      "running",
      "waiting_on_delegate",
    ]);
  });

  it("starts running only from queued, so a cancelled task is never picked up", () => {
    expect(allowedFrom("running").sort()).toEqual(["awaiting_approval", "queued"]);
    expect(canTransition("cancelled", "running")).toBe(false);
  });
});

describe("retry policy", () => {
  const lost: FailureFacts = {
    code: "worker_stopped",
    attempt: 1,
    autoRetriesLeft: 1,
    sideEffectsMayHaveRun: false,
    approvalWasPending: false,
  };

  it("retries a lost attempt that did nothing irreversible, with a doubling delay", () => {
    expect(decideAfterFailure(lost, 1_000)).toEqual({ action: "retry", delayMs: 1_000 });
    expect(decideAfterFailure({ ...lost, attempt: 3 }, 1_000)).toEqual({ action: "retry", delayMs: 4_000 });
  });

  it("retries a provider outage the same way", () => {
    expect(decideAfterFailure({ ...lost, code: "provider_unavailable" }, 1_000)).toEqual({ action: "retry", delayMs: 1_000 });
  });

  it("never retries a usage limit, a timeout, or a configuration problem", () => {
    for (const code of ["usage_limit", "timeout", "not_signed_in", "model_unavailable", "agent_unavailable", "unexpected"]) {
      expect(decideAfterFailure({ ...lost, code }, 1_000)).toEqual({ action: "fail" });
    }
  });

  it("interrupts instead of repeating an action that may have changed something", () => {
    expect(decideAfterFailure({ ...lost, sideEffectsMayHaveRun: true }, 1_000)).toEqual({
      action: "interrupt",
      reason: "side_effects",
    });
  });

  it("interrupts when an approval was pending: that session can't be resumed", () => {
    expect(decideAfterFailure({ ...lost, approvalWasPending: true }, 1_000)).toEqual({
      action: "interrupt",
      reason: "approval_pending",
    });
  });

  it("is bounded: with no retries left, a lost attempt is interrupted and an outage fails", () => {
    expect(decideAfterFailure({ ...lost, autoRetriesLeft: 0 }, 1_000)).toEqual({
      action: "interrupt",
      reason: "no_retries_left",
    });
    expect(decideAfterFailure({ ...lost, code: "provider_unavailable", autoRetriesLeft: 0 }, 1_000)).toEqual({
      action: "fail",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentServiceError } from "@/server/agents/errors";
import { OwnerAccessError } from "@/server/auth/owner";
import { toActionError } from "./result";

describe("toActionError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turns a missing owner into 'forbidden'", () => {
    expect(toActionError(new OwnerAccessError("No."))).toEqual({
      ok: false,
      error: { code: "forbidden", message: "No.", fieldErrors: {} },
    });
  });

  it("passes service errors through with their field errors", () => {
    const error = new AgentServiceError("name_taken", "Taken.", { name: ["Taken."] });
    expect(toActionError(error)).toEqual({
      ok: false,
      error: { code: "name_taken", message: "Taken.", fieldErrors: { name: ["Taken."] } },
    });
  });

  it("never sends internal details of unknown errors to the browser", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = toActionError(new Error('relation "secret_table" does not exist'));
    expect(result.error.code).toBe("unexpected");
    expect(JSON.stringify(result)).not.toContain("secret_table");
  });
});

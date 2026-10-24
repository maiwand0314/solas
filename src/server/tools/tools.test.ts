import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentTimeTool } from "./builtin/current-time";
import { listWorkspaceFilesTool, MAX_READ_BYTES, readWorkspaceFileTool } from "./builtin/workspace-files";
import { createToolRegistry, toolRegistry } from "./registry";
import { ToolError, type AnyToolDefinition } from "./types";
import { agentWorkspaceDir, ensureWorkspace, workspacesRoot } from "./workspace";

// Real files in a temporary directory: the safety rules are only worth
// something if they hold against the actual filesystem.

let sandbox: string;
let workspace: string;
let outside: string;
const context = () => ({ workspaceDir: workspace, signal: new AbortController().signal });

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "solas-tools-test-"));
  workspace = path.join(sandbox, "workspace");
  outside = path.join(sandbox, "outside");
  await mkdir(path.join(workspace, "notes"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(workspace, "readme.md"), "# Hello\nWorkspace notes.");
  await writeFile(path.join(workspace, "notes", "plan.md"), "Plan: ship M4A.");
  await writeFile(path.join(workspace, ".env"), "SECRET=1");
  await writeFile(path.join(workspace, "server.pem"), "-----BEGIN KEY-----");
  await writeFile(path.join(workspace, "big.txt"), "x".repeat(MAX_READ_BYTES + 1));
  await writeFile(path.join(workspace, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(path.join(workspace, "latin1.txt"), Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]));
  await writeFile(path.join(outside, "secret.txt"), "outside the workspace");
  await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link-to-secret.txt"));
  await symlink(outside, path.join(workspace, "link-to-outside"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function expectToolError(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).message).toMatch(message);
}

const read = (file: string) => readWorkspaceFileTool.execute({ path: file }, context());

describe("registry", () => {
  it("holds the three first tools, with unique, model-safe IDs", () => {
    expect(toolRegistry.list().map((tool) => tool.id)).toEqual([
      "current_time",
      "list_workspace_files",
      "read_workspace_file",
    ]);
    expect(toolRegistry.catalog()[0]).not.toHaveProperty("execute");
  });

  it("refuses duplicate IDs, unsafe IDs, and approval-required tools that default to running", () => {
    const base = { ...currentTimeTool } as AnyToolDefinition;
    expect(() => createToolRegistry([base, base])).toThrow(/twice/);
    expect(() => createToolRegistry([{ ...base, id: "Bad Name" }])).toThrow(/Invalid tool ID/);
    expect(() => createToolRegistry([{ ...base, approval: "required", defaultMode: "allow" }])).toThrow(/requires approval/);
  });
});

describe("current_time", () => {
  it("returns the time in a valid IANA time zone", async () => {
    const result = await currentTimeTool.execute({ timeZone: "Europe/Oslo" }, context());
    expect(result.timeZone).toBe("Europe/Oslo");
    expect(new Date(result.iso).getTime()).toBeCloseTo(Date.now(), -4);
  });

  it("rejects an unknown time zone with a clear message", async () => {
    await expectToolError(currentTimeTool.execute({ timeZone: "Mars/Olympus" }, context()), /isn’t a known time zone/);
  });

  it("validates its input: unknown fields and non-strings are refused", () => {
    expect(currentTimeTool.input.safeParse({ timeZone: 5 }).success).toBe(false);
    expect(currentTimeTool.input.safeParse({ timeZone: "UTC", command: "ls" }).success).toBe(false);
  });
});

describe("list_workspace_files", () => {
  it("lists one folder, hiding hidden files, key files, and links", async () => {
    const result = await listWorkspaceFilesTool.execute({ path: "." }, context());
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain("readme.md");
    expect(names).toContain("notes");
    for (const hidden of [".env", "server.pem", "link-to-secret.txt", "link-to-outside"]) {
      expect(names).not.toContain(hidden);
    }
  });

  it("lists a subfolder, and refuses to leave the workspace", async () => {
    const result = await listWorkspaceFilesTool.execute({ path: "notes" }, context());
    expect(result.entries.map((entry) => entry.name)).toEqual(["plan.md"]);
    await expectToolError(listWorkspaceFilesTool.execute({ path: ".." }, context()), /outside the workspace/);
    await expectToolError(listWorkspaceFilesTool.execute({ path: "link-to-outside" }, context()), /Symbolic links/);
  });
});

describe("read_workspace_file", () => {
  it("reads a text file in the workspace", async () => {
    expect(await read("notes/plan.md")).toEqual({ path: path.join("notes", "plan.md"), bytes: 15, content: "Plan: ship M4A." });
  });

  it.each([
    ["a parent-directory path", "../outside/secret.txt", /outside the workspace/],
    ["a sneaky traversal", "notes/../../outside/secret.txt", /outside the workspace/],
    ["an absolute path", "/etc/passwd", /relative to the workspace/],
    ["a symbolic link to a file", "link-to-secret.txt", /Symbolic links/],
    ["a path through a linked folder", "link-to-outside/secret.txt", /Symbolic links/],
    ["an environment file", ".env", /Hidden files/],
    ["a key file", "server.pem", /key files/],
    ["a null byte", "readme.md\0.txt", /invalid character/],
    ["a missing file", "nope.md", /doesn’t exist/],
  ])("refuses %s", async (_label, file, message) => {
    await expectToolError(read(file), message);
  });

  it("enforces the size limit, and refuses binary and non-UTF-8 files", async () => {
    await expectToolError(read("big.txt"), /the limit is/);
    await expectToolError(read("image.bin"), /binary/);
    await expectToolError(read("latin1.txt"), /UTF-8/);
  });

  it("refuses a folder", async () => {
    await expectToolError(read("notes"), /folder, not a file/);
  });
});

describe("workspaces", () => {
  it("lives under ~/Solas/workspaces by default, one folder per agent ID", () => {
    expect(workspacesRoot({})).toBe(path.join(os.homedir(), "Solas", "workspaces"));
    expect(workspacesRoot({ SOLAS_WORKSPACES_DIR: "/srv/solas" })).toBe("/srv/solas");
    expect(() => agentWorkspaceDir("../../etc")).toThrow(/Invalid agent ID/);
  });

  it("refuses a workspaces root that is the home folder or contains the app", async () => {
    const agentId = "00000000-0000-4000-8000-000000000000";
    await expect(ensureWorkspace(agentId, sandbox, os.homedir())).rejects.toThrow(/dedicated folder/);
    await expect(ensureWorkspace(agentId, path.join(sandbox, "app"), sandbox)).rejects.toThrow(/dedicated folder/);
    const created = await ensureWorkspace(agentId, path.join(sandbox, "app"), path.join(sandbox, "workspaces"));
    expect(created).toBe(path.join(sandbox, "workspaces", agentId));
  });
});

describe("output contracts", () => {
  it("every tool's output schema accepts what the tool returns", async () => {
    expect(currentTimeTool.output.safeParse(await currentTimeTool.execute({}, context())).success).toBe(true);
    const listed = await listWorkspaceFilesTool.execute({ path: "." }, context());
    expect(listWorkspaceFilesTool.output.safeParse(listed).success).toBe(true);
    expect(readWorkspaceFileTool.output.safeParse(await read("readme.md")).success).toBe(true);
  });
});

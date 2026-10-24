import "server-only";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type ToolDefinition } from "../types";
import { isProtectedName, READ_NO_FOLLOW, resolveWorkspacePath } from "../workspace";

// Read-only access to the agent's own workspace. No writing, no deleting, and
// nothing outside the workspace: every path goes through resolveWorkspacePath.

const MAX_ENTRIES = 200;
export const MAX_READ_BYTES = 256 * 1024;

const relativePath = z
  .string()
  .trim()
  .max(500)
  .describe('A path relative to the workspace, such as "notes" or "notes/plan.md". Use "" or "." for the top level.');

// ---------------------------------------------------------------------------

const listInput = z.strictObject({ path: relativePath.default(".") });
const listOutput = z.strictObject({
  path: z.string(),
  entries: z.array(z.strictObject({ name: z.string(), type: z.enum(["file", "directory"]), bytes: z.number() })),
  truncated: z.boolean(),
});

export const listWorkspaceFilesTool: ToolDefinition<typeof listInput, typeof listOutput> = {
  id: "list_workspace_files",
  name: "List workspace files",
  description:
    "Lists the files and folders in one folder of the agent's workspace (not recursive). Hidden files and key files are never shown.",
  input: listInput,
  output: listOutput,
  risk: "low",
  approval: "optional",
  capability: "workspace-read",
  defaultMode: "allow",
  timeoutMs: 5_000,
  maxOutputChars: 20_000,
  summarizeInput: ({ path: folder }) => (folder === "" || folder === "." ? "workspace (top level)" : folder),
  summarizeOutput: ({ entries, truncated }) =>
    `${entries.length}${truncated ? "+" : ""} ${entries.length === 1 ? "entry" : "entries"}`,
  async execute({ path: folder }, { workspaceDir }) {
    const dir = await resolveWorkspacePath(workspaceDir, folder || ".");
    if (!(await stat(dir)).isDirectory()) throw new ToolError(`“${folder}” is a file, not a folder.`);

    const entries: z.output<typeof listOutput>["entries"] = [];
    let truncated = false;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Links and special files are left out, like hidden and key files.
      if (isProtectedName(entry.name) || !(entry.isFile() || entry.isDirectory())) continue;
      if (entries.length === MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const bytes = entry.isFile() ? (await stat(path.join(dir, entry.name))).size : 0;
      entries.push({ name: entry.name, type: entry.isFile() ? "file" : "directory", bytes });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: path.relative(workspaceDir, dir) || ".", entries, truncated };
  },
};

// ---------------------------------------------------------------------------

const readInput = z.strictObject({ path: relativePath.min(1) });
const readOutput = z.strictObject({ path: z.string(), bytes: z.number(), content: z.string() });

export const readWorkspaceFileTool: ToolDefinition<typeof readInput, typeof readOutput> = {
  id: "read_workspace_file",
  name: "Read workspace file",
  description: `Reads one UTF-8 text file from the agent's workspace, up to ${MAX_READ_BYTES / 1024} KB. Binary, hidden, and key files can't be read.`,
  input: readInput,
  output: readOutput,
  risk: "medium",
  approval: "optional",
  capability: "workspace-read",
  defaultMode: "allow",
  timeoutMs: 5_000,
  maxOutputChars: 270_000,
  summarizeInput: ({ path: file }) => file,
  summarizeOutput: ({ path: file, bytes }) => `${file} (${formatBytes(bytes)})`,
  async execute({ path: file }, { workspaceDir }) {
    const target = await resolveWorkspacePath(workspaceDir, file);
    // O_NOFOLLOW: refuse if the file was replaced by a link after the checks.
    const handle = await open(target, READ_NO_FOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP") throw new ToolError("Symbolic links aren’t followed.");
      throw error;
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ToolError(`“${file}” is a folder, not a file.`);
      if (info.size > MAX_READ_BYTES) {
        throw new ToolError(`“${file}” is ${formatBytes(info.size)}; the limit is ${formatBytes(MAX_READ_BYTES)}.`);
      }
      const buffer = await handle.readFile();
      if (buffer.subarray(0, 8192).includes(0)) throw new ToolError(`“${file}” looks like a binary file, not text.`);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new ToolError(`“${file}” isn’t valid UTF-8 text.`);
      }
      return { path: path.relative(workspaceDir, target), bytes: buffer.length, content };
    } finally {
      await handle.close();
    }
  },
};

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

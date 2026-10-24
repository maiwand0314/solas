import "server-only";
import { constants } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./types";

// Agent workspaces: one directory per agent, the only place file tools may
// look. Everything that turns an agent-supplied path into a real path goes
// through resolveWorkspacePath, which refuses anything that could reach
// outside the workspace or into secrets.

/** ~/Solas/workspaces by default; SOLAS_WORKSPACES_DIR overrides it. */
export function workspacesRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.SOLAS_WORKSPACES_DIR?.trim();
  return path.resolve(configured || path.join(os.homedir(), "Solas", "workspaces"));
}

/** The workspace of one agent. Named by ID, so renaming an agent doesn't move it. */
export function agentWorkspaceDir(agentId: string, root = workspacesRoot()): string {
  if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error("Invalid agent ID for a workspace.");
  return path.join(root, agentId);
}

/** The workspace path as the owner would type it, with "~" for the home folder. */
export function displayWorkspacePath(agentId: string | null, root = workspacesRoot()): string {
  const full = agentId ? agentWorkspaceDir(agentId, root) : path.join(root, "<agent-id>");
  const home = os.homedir();
  return full.startsWith(home + path.sep) ? `~${full.slice(home.length)}` : full;
}

/**
 * Creates the workspace if needed, after checking that its root is a
 * dedicated directory: not the filesystem root, not the home directory, and
 * not inside (or around) the Solas app itself.
 */
export async function ensureWorkspace(agentId: string, appDirectory = process.cwd(), root = workspacesRoot()) {
  const home = os.homedir();
  if (root === path.parse(root).root || root === home || isInside(root, appDirectory) || isInside(appDirectory, root)) {
    throw new Error(`The workspaces directory ${root} must be a dedicated folder outside the Solas app.`);
  }
  const dir = agentWorkspaceDir(agentId, root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Names that are never listed or read: hidden files (.env, .git, .ssh, …) and key files. */
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx"];
export function isProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(".") || SECRET_EXTENSIONS.some((extension) => lower.endsWith(extension)) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(lower);
}

/**
 * Turns a path the agent supplied (relative to its workspace) into an
 * absolute path inside the workspace, or throws a ToolError. Refuses:
 * absolute paths, "..", hidden or key files, and symbolic links anywhere on
 * the way (a link could point anywhere on the Mac).
 */
export async function resolveWorkspacePath(workspaceDir: string, relative: string): Promise<string> {
  if (relative.includes("\0")) throw new ToolError("The path contains an invalid character.");
  if (path.isAbsolute(relative)) throw new ToolError("Use a path relative to the workspace, not an absolute path.");
  const target = path.resolve(workspaceDir, relative);
  if (!isInside(target, workspaceDir)) throw new ToolError("That path is outside the workspace.");

  const parts = path.relative(workspaceDir, target).split(path.sep).filter(Boolean);
  if (parts.some(isProtectedName)) throw new ToolError("Hidden files and key files can't be accessed.");

  // Check every step for a symbolic link, from the workspace down to the target.
  let current = workspaceDir;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new ToolError(`“${relative}” doesn’t exist in the workspace.`);
      throw error;
    });
    if (info.isSymbolicLink()) throw new ToolError("Symbolic links aren’t followed.");
  }

  // Belt and braces: the real path must still be inside the real workspace.
  const [realTarget, realWorkspace] = await Promise.all([realpath(target), realpath(workspaceDir)]);
  if (!isInside(realTarget, realWorkspace)) throw new ToolError("That path is outside the workspace.");
  return target;
}

/** Open flags for reading a file without following a link swapped in at the last moment. */
export const READ_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

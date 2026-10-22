import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DirtyWorktreeError, GitError, SyncConflictError } from "./errors.js";
import { collectTree, isIgnored } from "./snapshot.js";

const gitIdentity = ["-c", "user.name=texleaf", "-c", "user.email=texleaf@example.invalid"];

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runGit(
  repo: string,
  args: string[],
  options: { check?: boolean; identity?: boolean; env?: NodeJS.ProcessEnv } = {}
): GitResult {
  const command = ["git", ...(options.identity ? gitIdentity : []), ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repo,
    env: { ...process.env, ...options.env },
    encoding: "utf8"
  });
  const code = result.status ?? 1;
  const gitResult = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code
  };
  if (options.check !== false && code !== 0) {
    throw new GitError(`Git command failed: ${command.join(" ")}\n${gitResult.stderr || gitResult.stdout}`);
  }
  return gitResult;
}

export function isGitRepo(repo: string): boolean {
  const result = runGit(repo, ["rev-parse", "--show-toplevel"], { check: false });
  return result.code === 0 && path.resolve(result.stdout.trim()) === path.resolve(repo);
}

export function ensureGitRepo(repo: string, mainBranch: string): void {
  if (!isGitRepo(repo)) {
    const result = runGit(repo, ["init", "-b", mainBranch], { check: false });
    if (result.code !== 0) {
      runGit(repo, ["init"]);
      runGit(repo, ["switch", "-c", mainBranch]);
    }
  }
}

export function currentBranch(repo: string): string {
  const branch = runGit(repo, ["branch", "--show-current"]).stdout.trim();
  if (!branch) throw new GitError("Detached HEAD is not supported.");
  return branch;
}

export function branchExists(repo: string, branch: string): boolean {
  return runGit(repo, ["show-ref", "--verify", `refs/heads/${branch}`], { check: false }).code === 0;
}

export function headCommit(repo: string, ref = "HEAD"): string {
  return runGit(repo, ["rev-parse", ref]).stdout.trim();
}

export function mergeBase(repo: string, a: string, b: string): string | undefined {
  const result = runGit(repo, ["merge-base", a, b], { check: false });
  const commit = result.stdout.trim();
  return result.code === 0 && commit ? commit : undefined;
}

export function requireCleanWorktree(repo: string): void {
  if (worktreeChanges(repo).length) throw new DirtyWorktreeError();
}

export function worktreeChanges(repo: string): string[] {
  const result = runGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude).texleaf"]);
  return result.stdout.split("\0").filter(Boolean);
}

export function conflictedFiles(repo: string): string[] {
  return runGit(repo, ["diff", "--name-only", "--diff-filter=U"], { check: false })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
}

export function gitIgnoredTrackedFiles(repo: string): string[] {
  return runGit(repo, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"], { check: false })
    .stdout.split("\0")
    .filter(Boolean);
}

export function requireNoConflicts(repo: string): void {
  const files = conflictedFiles(repo);
  if (files.length) throw new SyncConflictError(files);
}

export function hasDiffBetween(repo: string, base: string, head = "HEAD"): boolean {
  return runGit(repo, ["diff", "--quiet", base, head, "--", ".", ":(exclude).texleaf"], { check: false }).code === 1;
}

export function mergeBranch(repo: string, branch: string, commit = false): void {
  const args = ["merge", "--no-ff", branch];
  if (!commit) args.push("--no-commit");
  const result = runGit(repo, args, { check: false });
  if (result.code !== 0) {
    const conflicts = conflictedFiles(repo);
    if (conflicts.length) throw new SyncConflictError(conflicts);
    throw new GitError(`Git merge failed:\n${result.stderr || result.stdout}`);
  }
}

export function resetHard(repo: string, ref: string): void {
  runGit(repo, ["reset", "--hard", ref]);
}

export function forceBranch(repo: string, branch: string, ref = "HEAD"): void {
  runGit(repo, ["branch", "-f", branch, ref]);
}

export async function importSnapshotToBranch(args: {
  repo: string;
  snapshotDir: string;
  branch: string;
  patterns: string[];
  message: string;
  additionalParent?: string;
  preserveIgnoredFrom?: string;
}): Promise<string> {
  const files = await collectTree(args.snapshotDir, args.patterns);
  const parent = branchExists(args.repo, args.branch) ? headCommit(args.repo, args.branch) : undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-index-"));
  const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    runGit(args.repo, ["read-tree", "--empty"], { env });
    for (const [projectPath, content] of files) {
      const objectId = await hashBlob(args.repo, content);
      runGit(args.repo, ["update-index", "--add", "--cacheinfo", "100644", objectId, projectPath], { env });
    }
    const ignoredTracked = new Set(gitIgnoredTrackedFiles(args.repo));
    const ignoredSources = args.preserveIgnoredFrom ? [args.preserveIgnoredFrom] : parent ? [parent] : [];
    const preserved = new Map<string, { mode: string; objectId: string }>();
    for (const source of ignoredSources) {
      const entries = runGit(args.repo, ["ls-tree", "-r", "-z", source]).stdout.split("\0").filter(Boolean);
      for (const entry of entries) {
        const tab = entry.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, objectId] = entry.slice(0, tab).split(" ");
        const projectPath = entry.slice(tab + 1);
        if (type !== "blob" || !mode || !objectId || preserved.has(projectPath)) continue;
        const ignoredByGit = ignoredTracked.has(projectPath)
          || runGit(args.repo, ["check-ignore", "--no-index", "--quiet", "--", projectPath], { check: false }).code === 0;
        if (isIgnored(projectPath, args.patterns) || ignoredByGit) preserved.set(projectPath, { mode, objectId });
      }
    }
    for (const [projectPath, { mode, objectId }] of preserved) {
      runGit(args.repo, ["update-index", "--add", "--cacheinfo", mode, objectId, projectPath], { env });
    }
    const tree = runGit(args.repo, ["write-tree"], { env }).stdout.trim();
    const commitArgs = ["commit-tree", tree, "-m", args.message];
    if (parent) commitArgs.push("-p", parent);
    if (args.additionalParent && args.additionalParent !== parent) commitArgs.push("-p", args.additionalParent);
    const commit = runGit(args.repo, commitArgs, { identity: true }).stdout.trim();
    const updateArgs = ["update-ref", `refs/heads/${args.branch}`, commit];
    if (parent) updateArgs.push(parent);
    runGit(args.repo, updateArgs);
    return commit;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function nameStatusDiff(repo: string, base: string, head = "HEAD"): string[][] {
  const out = runGit(repo, ["diff", "--name-status", "--find-renames", "-z", base, head]).stdout;
  const fields = out.split("\0");
  const rows: string[][] = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index++];
    if (status.startsWith("R")) rows.push([status, fields[index++], fields[index++]]);
    else rows.push([status, fields[index++]]);
  }
  return rows;
}

async function hashBlob(repo: string, content: Buffer): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["hash-object", "-w", "--stdin"], { cwd: repo });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("ascii").trim());
      else reject(new GitError(`Git hash-object failed:\n${Buffer.concat(stderr).toString("utf8")}`));
    });
    child.stdin.end(content);
  });
}

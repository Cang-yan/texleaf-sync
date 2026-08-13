import fs from "node:fs/promises";

import { gitIgnoredTrackedFiles, nameStatusDiff } from "./git.js";
import { isIgnored } from "./snapshot.js";

export interface PushOperation {
  status: string;
  path: string;
  oldPath?: string;
  isText: boolean;
}

const textExtensions = new Set([
  ".tex",
  ".bib",
  ".sty",
  ".cls",
  ".bst",
  ".txt",
  ".md",
  ".yaml",
  ".yml",
  ".json",
  ".csv"
]);

export async function buildPushPlan(repo: string, base: string, patterns: string[]): Promise<PushOperation[]> {
  const operations: PushOperation[] = [];
  const gitIgnored = new Set(gitIgnoredTrackedFiles(repo));
  for (const row of nameStatusDiff(repo, base)) {
    const status = row[0];
    const oldPath = status.startsWith("R") ? row[1] : undefined;
    const projectPath = status.startsWith("R") ? row[2] : row[1];
    if (!projectPath || isIgnored(projectPath, patterns) || (oldPath && isIgnored(oldPath, patterns))) continue;
    if (gitIgnored.has(projectPath) || (oldPath && gitIgnored.has(oldPath))) continue;
    const content = status === "D" ? undefined : await fs.readFile(`${repo}/${projectPath}`).catch(() => Buffer.alloc(0));
    operations.push({
      status,
      path: projectPath,
      oldPath,
      isText: status === "D" ? true : isTextPath(projectPath, content)
    });
  }
  return operations;
}

export function formatPushPlan(operations: PushOperation[]): string {
  if (!operations.length) return "Planned Overleaf operations:\n  (none)";
  return [
    "Planned Overleaf operations:",
    ...operations.map((op) => (op.oldPath ? `  R ${op.oldPath} -> ${op.path}` : `  ${op.status[0]} ${op.path}`))
  ].join("\n");
}

function isTextPath(projectPath: string, content?: Buffer): boolean {
  const extension = projectPath.slice(projectPath.lastIndexOf(".")).toLowerCase();
  if (textExtensions.has(extension)) return true;
  if (!content) return true;
  if (content.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

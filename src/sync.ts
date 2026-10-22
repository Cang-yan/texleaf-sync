import fs from "node:fs/promises";
import path from "node:path";

import { createProjectBackend, type ProjectBackend } from "./project-backend.js";
import { type TexleafConfig, defaultConfig, ensureProjectGitignore, loadConfig, resolveRepoPath, writeConfig } from "./config.js";
import { buildPushPlan, formatPushPlan, type PushOperation } from "./diff.js";
import { ConfigError, DirtyWorktreeError, TexleafError } from "./errors.js";
import {
  branchExists,
  currentBranch,
  ensureGitRepo,
  gitIgnoredTrackedFiles,
  hasDiffBetween,
  headCommit,
  importSnapshotToBranch,
  mergeBase,
  mergeBranch,
  requireCleanWorktree,
  requireNoConflicts,
  resetHard,
  runGit,
  worktreeChanges
} from "./git.js";
import { ensureDir, exists, isDirectory, isEmptyDirectory, removeDirectoriesByPrefix, writeJsonAtomic } from "./files.js";
import { info } from "./log.js";
import { type PlatformName, globalSessionFile, hostPlatform, normalizeHost, platformDisablesTls, platformHost } from "./platform.js";
import { collectTreeHashes, compareTrees } from "./snapshot.js";

export interface CloneOptions {
  host?: string;
  platform?: PlatformName | "custom";
  projectId: string;
  ownerKey?: string;
  versionNo?: string;
  projectName?: string;
  directory?: string;
  profile: string;
  sessionFile?: string;
  force?: boolean;
  insecure?: boolean;
}

type ProjectBackendFactory = (repo: string, config: TexleafConfig) => ProjectBackend;

export class SyncEngine {
  constructor(private readonly root: string, private readonly backendFactory: ProjectBackendFactory = createProjectBackend) {}

  async clone(options: CloneOptions): Promise<string> {
    const host = normalizeHost(options.host ?? (options.platform && options.platform !== "custom" ? platformHost(options.platform) : ""));
    const platform = options.platform ?? hostPlatform(host);
    const sessionFile =
      options.sessionFile ?? (platform !== "custom" ? globalSessionFile(platform, options.profile) : ".texleaf/session.json");
    const sslVerify = options.insecure ? false : !platformDisablesTls(platform, host);
    const probeConfig = defaultConfig({
      repoRoot: this.root,
      host,
      projectId: options.projectId,
      ownerKey: options.ownerKey,
      versionNo: options.versionNo,
      projectName: options.projectName ?? options.projectId,
      platform,
      profile: options.profile,
      sessionFile,
      sslVerify
    });
    const probe = this.backendFactory(this.root, probeConfig);
    await probe.authenticate();
    const remoteIdentity = probe.projectIdentity ? await probe.projectIdentity(options.projectId) : undefined;
    const remoteName = options.projectName ?? remoteIdentity?.projectName ?? (await probe.projectName(options.projectId)) ?? options.projectId;
    const ownerKey = options.ownerKey ?? remoteIdentity?.ownerKey;
    const versionNo = options.versionNo ?? remoteIdentity?.versionNo;
    const target = path.resolve(this.root, options.directory ?? safeDirectoryName(remoteName));
    if ((await exists(target)) && !(await isDirectory(target))) {
      throw new ConfigError(`Clone destination exists and is not a directory: ${target}`);
    }
    if ((await exists(target)) && !(await isEmptyDirectory(target)) && !options.force) {
      throw new ConfigError(`Clone destination is not empty: ${target}`);
    }
    await ensureDir(target);
    const config = defaultConfig({
      repoRoot: target,
      host,
      projectId: options.projectId,
      ownerKey,
      versionNo,
      projectName: remoteName,
      platform,
      profile: options.profile,
      sessionFile: path.isAbsolute(sessionFile) ? sessionFile : path.resolve(this.root, sessionFile),
      sslVerify
    });
    await this.initInto(target, config);
    return target;
  }

  async pull(): Promise<void> {
    const config = await loadConfig(this.root);
    const backend = this.backendFactory(this.root, config);
    await withLock(resolveRepoPath(this.root, config.sync.lockFile), async () => {
      requireCleanWorktree(this.root);
      await backend.authenticate();
      const remoteCommit = await this.importLatestSnapshot(config, backend, "overleaf: snapshot");
      const remoteBranch = config.git.remoteBranch;
      const mainBranch = currentBranch(this.root);
      const base = mergeBase(this.root, remoteBranch, mainBranch);
      if (base !== undefined && !hasDiffBetween(this.root, base, remoteBranch)) {
        await this.writeMetadata(config.sync.lastRemoteSnapshotFile, remoteCommit);
        await this.writeMetadata(config.sync.lastSyncedFile, headCommit(this.root));
        info("Pull completed; remote has no new changes.");
        return;
      }
      info(`Merging ${remoteBranch} into ${mainBranch}...`);
      mergeBranch(this.root, remoteBranch, false);
      await this.writeMetadata(config.sync.lastRemoteSnapshotFile, remoteCommit);
      if (worktreeChanges(this.root).length) {
        info("Pull staged remote changes. Review and commit them before pushing.");
      }
    });
  }

  async status(json = false): Promise<void> {
    const config = await loadConfig(this.root);
    const branch = currentBranch(this.root);
    const dirty = worktreeChanges(this.root);
    const base = branchExists(this.root, config.git.remoteBranch) ? headCommit(this.root, config.git.remoteBranch) : undefined;
    const changes = base ? await buildPushPlan(this.root, base, config.ignore.patterns) : [];
    const data = {
      project: config.project,
      branch,
      clean: dirty.length === 0,
      workingTreeChanges: dirty,
      changes
    };
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`Project: ${config.project.projectName}`);
    console.log(`Host: ${config.project.host}`);
    console.log(`Platform: ${config.project.platform}`);
    console.log(`Current branch: ${branch}`);
    console.log(`Working tree clean: ${dirty.length === 0 ? "yes" : "no"}`);
    console.log(formatPushPlan(changes));
  }

  async verify(allowDiff = false): Promise<void> {
    const config = await loadConfig(this.root);
    const backend = this.backendFactory(this.root, config);
    await withLock(resolveRepoPath(this.root, config.sync.lockFile), async () => {
      await backend.authenticate();
      const snapshot = await this.downloadSnapshot(config, backend);
      try {
        const remote = await collectTreeHashes(snapshot, config.ignore.patterns);
        const local = await this.localTreeHashes(config);
        const diff = compareTrees(remote, local);
        printTreeDiff(diff);
        if ((diff.added.length || diff.modified.length || diff.deleted.length) && !allowDiff) {
          throw new TexleafError("Remote snapshot differs from local normalized project state.");
        }
      } finally {
        await fs.rm(snapshot, { recursive: true, force: true });
      }
    });
  }

  async push(dryRun = false): Promise<void> {
    const config = await loadConfig(this.root);
    const backend = this.backendFactory(this.root, config);
    await withLock(resolveRepoPath(this.root, config.sync.lockFile), async () => {
      requireNoConflicts(this.root);
      requireCleanWorktree(this.root);
      if (!dryRun) {
        info("Running freshness pull before push...");
        await backend.authenticate();
        const remoteCommit = await this.importLatestSnapshot(config, backend, "overleaf: freshness snapshot");
        const base = mergeBase(this.root, config.git.remoteBranch, currentBranch(this.root));
        if (base === undefined || hasDiffBetween(this.root, base, config.git.remoteBranch)) {
          mergeBranch(this.root, config.git.remoteBranch, false);
          await this.writeMetadata(config.sync.lastRemoteSnapshotFile, remoteCommit);
          throw new DirtyWorktreeError("Freshness pull staged remote changes. Review and commit them before push.");
        }
      }
      const base = headCommit(this.root, config.git.remoteBranch);
      const plan = await buildPushPlan(this.root, base, config.ignore.patterns);
      console.log(formatPushPlan(plan));
      if (dryRun || !plan.length) return;
      await this.applyPushPlan(config, backend, plan);
      const snapshot = await this.downloadSnapshot(config, backend);
      try {
        const remote = await collectTreeHashes(snapshot, config.ignore.patterns);
        const local = await this.localTreeHashes(config);
        const diff = compareTrees(remote, local);
        if (diff.added.length || diff.modified.length || diff.deleted.length) {
          printTreeDiff(diff);
          throw new TexleafError("Remote verification failed; sync metadata was not updated.");
        }
        const verifiedLocalHead = headCommit(this.root);
        const remoteCommit = await importSnapshotToBranch({
          repo: this.root,
          snapshotDir: snapshot,
          branch: config.git.remoteBranch,
          patterns: config.ignore.patterns,
          message: "overleaf: snapshot after push",
          additionalParent: verifiedLocalHead,
          preserveIgnoredFrom: verifiedLocalHead
        });
        await this.writeMetadata(config.sync.lastSyncedFile, verifiedLocalHead);
        await this.writeMetadata(config.sync.lastRemoteSnapshotFile, remoteCommit);
        info("Push verification succeeded.");
      } finally {
        await fs.rm(snapshot, { recursive: true, force: true });
      }
    });
  }

  private async initInto(repo: string, config: TexleafConfig): Promise<void> {
    const backend = this.backendFactory(repo, config);
    await backend.authenticate();
    await writeConfig(repo, config);
    ensureGitRepo(repo, config.git.mainBranch);
    const snapshot = await this.downloadSnapshot(config, backend, repo);
    let remoteCommit: string;
    try {
      remoteCommit = await importSnapshotToBranch({
        repo,
        snapshotDir: snapshot,
        branch: config.git.remoteBranch,
        patterns: config.ignore.patterns,
        message: "overleaf: initial snapshot"
      });
    } finally {
      await fs.rm(snapshot, { recursive: true, force: true });
    }
    resetHard(repo, config.git.remoteBranch);
    await ensureProjectGitignore(repo);
    runGit(repo, ["add", "-A", "--", "."]);
    if (runGit(repo, ["diff", "--cached", "--quiet"], { check: false }).code === 1) {
      runGit(repo, ["commit", "-m", "overleaf: initial snapshot"], { identity: true });
    }
    await this.writeMetadata(config.sync.lastSyncedFile, headCommit(repo), repo);
    await this.writeMetadata(config.sync.lastRemoteSnapshotFile, remoteCommit, repo);
    info(`Initialized texleaf metadata at ${path.join(repo, ".texleaf", "config.json")}.`);
  }

  private async importLatestSnapshot(config: TexleafConfig, backend: ProjectBackend, message: string): Promise<string> {
    const snapshot = await this.downloadSnapshot(config, backend);
    try {
      return await importSnapshotToBranch({
        repo: this.root,
        snapshotDir: snapshot,
        branch: config.git.remoteBranch,
        patterns: config.ignore.patterns,
        message
      });
    } finally {
      await fs.rm(snapshot, { recursive: true, force: true });
    }
  }

  private async downloadSnapshot(config: TexleafConfig, backend: ProjectBackend, repo = this.root): Promise<string> {
    const snapshotRoot = resolveRepoPath(repo, config.sync.snapshotDir);
    await ensureDir(snapshotRoot);
    await removeDirectoriesByPrefix(snapshotRoot, "snapshot-");
    const dir = await fs.mkdtemp(path.join(snapshotRoot, "snapshot-"));
    await backend.downloadSnapshot(config.project.projectId, dir);
    return dir;
  }

  private async localTreeHashes(config: TexleafConfig): Promise<Map<string, string>> {
    const local = await collectTreeHashes(this.root, config.ignore.patterns);
    for (const ignored of gitIgnoredTrackedFiles(this.root)) local.delete(ignored);
    return local;
  }

  private async applyPushPlan(config: TexleafConfig, backend: ProjectBackend, plan: PushOperation[]): Promise<void> {
    let index = 0;
    for (const op of plan) {
      index++;
      info(`Applying ${index}/${plan.length}: ${op.oldPath ? `${op.oldPath} -> ${op.path}` : op.path}`);
      const parent = path.posix.dirname(op.path);
      if (op.status !== "D" && parent !== ".") await backend.createFolder(config.project.projectId, parent);
      if (op.status === "D") {
        await backend.deletePath(config.project.projectId, op.path);
      } else if (op.status.startsWith("R") && op.oldPath) {
        await backend.movePath(config.project.projectId, op.oldPath, op.path);
        if (op.status !== "R100") await this.writeFile(config, backend, op);
      } else {
        await this.writeFile(config, backend, op);
      }
    }
  }

  private async writeFile(config: TexleafConfig, backend: ProjectBackend, op: PushOperation): Promise<void> {
    const content = await fs.readFile(path.join(this.root, op.path));
    if (op.isText) await backend.writeTextFile(config.project.projectId, op.path, content.toString("utf8"));
    else await backend.uploadBinaryFile(config.project.projectId, op.path, content);
  }

  private async writeMetadata(file: string, value: string, repo = this.root): Promise<void> {
    await writeJsonAtomic(resolveRepoPath(repo, file), value, 0o600);
  }
}

async function withLock<T>(lockFile: string, action: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(lockFile));
  const handle = await fs.open(lockFile, "wx").catch(() => {
    throw new TexleafError(`Another texleaf operation is running: ${lockFile}`);
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    await fs.rm(lockFile, { force: true });
  }
}

function safeDirectoryName(value: string): string {
  return value.trim().replace(/[/:\\\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "") || "overleaf-project";
}

function printTreeDiff(diff: { added: string[]; modified: string[]; deleted: string[] }): void {
  if (!diff.added.length && !diff.modified.length && !diff.deleted.length) {
    console.log("Remote snapshot matches local normalized project state.");
    return;
  }
  for (const pathName of diff.added) console.log(`A ${pathName}`);
  for (const pathName of diff.modified) console.log(`M ${pathName}`);
  for (const pathName of diff.deleted) console.log(`D ${pathName}`);
}

import fs from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors.js";
import { ensureDir, exists, readJson, writeJsonAtomic } from "./files.js";
import {
  type PlatformName,
  globalSessionFile,
  hostPlatform,
  isPlatformName,
  normalizeHost,
  platformDisablesTls
} from "./platform.js";

export interface TexleafConfig {
  project: {
    host: string;
    projectId: string;
    ownerKey?: string;
    versionNo?: string;
    projectName: string;
    platform: PlatformName | "custom";
  };
  git: {
    mainBranch: string;
    remoteBranch: string;
  };
  backend: {
    timeoutMs: number;
    sslVerify: boolean;
  };
  auth: {
    profile: string;
    sessionFile: string;
  };
  sync: {
    snapshotDir: string;
    lockFile: string;
    lastSyncedFile: string;
    lastRemoteSnapshotFile: string;
  };
  ignore: {
    patterns: string[];
  };
}

export const DEFAULT_TIMEOUT_MS = 16_000;

export const defaultIgnorePatterns = [
  ".git/",
  ".gitignore",
  ".DS_Store",
  ".env",
  ".texleaf/",
  "*.aux",
  "*.bcf",
  "*.blg",
  "*.fdb_latexmk",
  "*.fls",
  "*.glg",
  "*.glo",
  "*.gls",
  "*.idx",
  "*.ilg",
  "*.ind",
  "*.lof",
  "*.log",
  "*.lot",
  "*.nav",
  "*.out",
  "*.run.xml",
  "*.snm",
  "*.synctex.gz",
  "*.toc",
  "*.vrb",
  "*.xdv"
];

export function configPath(repo: string): string {
  return path.join(repo, ".texleaf", "config.json");
}

export function resolveRepoPath(repo: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repo, value);
}

export function defaultConfig(args: {
  repoRoot: string;
  host: string;
  projectId: string;
  ownerKey?: string;
  versionNo?: string;
  projectName: string;
  platform?: PlatformName | "custom";
  profile?: string;
  sessionFile?: string;
  sslVerify?: boolean;
}): TexleafConfig {
  const host = normalizeHost(args.host);
  const platform = args.platform ?? hostPlatform(host);
  return {
    project: {
      host,
      projectId: args.projectId,
      ownerKey: args.ownerKey,
      versionNo: args.versionNo,
      projectName: args.projectName,
      platform
    },
    git: {
      mainBranch: "main",
      remoteBranch: "texleaf-remote"
    },
    backend: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      sslVerify: args.sslVerify ?? !platformDisablesTls(platform, host)
    },
    auth: {
      profile: args.profile ?? "default",
      sessionFile:
        args.sessionFile ??
        (isPlatformName(platform) ? globalSessionFile(platform, args.profile) : ".texleaf/session.json")
    },
    sync: {
      snapshotDir: ".texleaf/snapshots",
      lockFile: ".texleaf/lock",
      lastSyncedFile: ".texleaf/last_synced_commit",
      lastRemoteSnapshotFile: ".texleaf/last_remote_snapshot_commit"
    },
    ignore: {
      patterns: [...defaultIgnorePatterns]
    }
  };
}

export async function loadConfig(repo: string): Promise<TexleafConfig> {
  const target = configPath(repo);
  if (!(await exists(target))) throw new ConfigError(`Missing config file: ${target}`);
  const config = await readJson<TexleafConfig>(target);
  if (!config.project?.projectId) throw new ConfigError("Invalid .texleaf/config.json: missing project.projectId");
  const defaults = defaultConfig({
    repoRoot: repo,
    host: config.project.host,
    projectId: config.project.projectId,
    ownerKey: config.project.ownerKey,
    versionNo: config.project.versionNo,
    projectName: config.project.projectName ?? config.project.projectId,
    platform: config.project.platform ?? hostPlatform(config.project.host),
    profile: config.auth?.profile,
    sessionFile: config.auth?.sessionFile,
    sslVerify: config.backend?.sslVerify
  });
  // Merge section by section: a partial section in the file must not drop the
  // remaining defaults (an undefined git.remoteBranch or backend.sslVerify would
  // silently break the remote branch or TLS verification).
  return {
    ...defaults,
    ...config,
    project: {
      ...defaults.project,
      ...config.project,
      host: normalizeHost(config.project.host),
      platform: config.project.platform ?? hostPlatform(config.project.host)
    },
    git: { ...defaults.git, ...config.git },
    backend: { ...defaults.backend, ...config.backend },
    auth: { ...defaults.auth, ...config.auth },
    sync: { ...defaults.sync, ...config.sync },
    ignore: { ...defaults.ignore, ...config.ignore }
  };
}

export async function writeConfig(repo: string, config: TexleafConfig): Promise<void> {
  await writeJsonAtomic(configPath(repo), config, 0o600);
}

export async function ensureProjectGitignore(repo: string): Promise<void> {
  const target = path.join(repo, ".gitignore");
  const desired = [".texleaf/", ".env"];
  let current = "";
  if (await exists(target)) current = await fs.readFile(target, "utf8");
  const lines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missing = desired.filter((line) => !lines.has(line));
  if (!missing.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
}

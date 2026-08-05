#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";

import { type AuthSession, checkSession, loadSession, loginWithPassword, saveSession, sessionFromCookieHeader } from "./auth.js";
import { loadConfig, resolveRepoPath } from "./config.js";
import { TexleafError } from "./errors.js";
import { exists } from "./files.js";
import { warn } from "./log.js";
import {
  type PlatformName,
  globalSessionFile,
  hostPlatform,
  isPlatformName,
  normalizeHost,
  platformCookieNames,
  platformDisablesTls,
  platformHost,
  platforms
} from "./platform.js";
import { SyncEngine } from "./sync.js";

const program = new Command();

program
  .name("texleaf")
  .description("Git-safe Overleaf Community Edition sync CLI")
  .version("0.1.1");

program
  .command("clone")
  .description("download an Overleaf project into a new local Git repository")
  .option("--platform <name>", "known platform: cstcloud or overleaf")
  .option("--host <url>", "custom Overleaf host")
  .option("--project-name <name>", "override local project name")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .option("--force", "allow cloning into a non-empty directory")
  .option("--insecure", "disable TLS verification")
  .argument("<project-id>", "Overleaf project id")
  .argument("[directory]", "destination directory")
  .action(async (projectId: string, directory: string | undefined, options) => {
    const target = await new SyncEngine(process.cwd()).clone({
      host: options.host,
      platform: await resolvePlatform(options.platform, options.host, options.profile),
      projectId,
      projectName: options.projectName,
      directory,
      profile: options.profile,
      sessionFile: options.sessionFile,
      force: Boolean(options.force),
      insecure: Boolean(options.insecure)
    });
    console.log(`Cloned Overleaf project to ${target}`);
  });

program.command("pull").description("import latest remote snapshot through Git").action(async () => {
  await new SyncEngine(process.cwd()).pull();
});

program
  .command("push")
  .description("apply committed local changes to Overleaf")
  .option("--dry-run", "print the push plan without writing")
  .action(async (options) => {
    await new SyncEngine(process.cwd()).push(Boolean(options.dryRun));
  });

program
  .command("status")
  .description("show local sync status")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await new SyncEngine(process.cwd()).status(Boolean(options.json));
  });

program
  .command("verify")
  .description("compare latest remote snapshot with local files")
  .option("--allow-diff", "exit zero when differences are found")
  .action(async (options) => {
    await new SyncEngine(process.cwd()).verify(Boolean(options.allowDiff));
  });

const auth = program.command("auth").description("manage saved Overleaf sessions");

auth
  .command("login")
  .description("save a reusable Overleaf session")
  .option("--platform <name>", "known platform: cstcloud or overleaf")
  .option("--host <url>", "custom Overleaf host")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .option("--email <email>", "Overleaf email for password login")
  .option("--password <password>", "Overleaf password")
  .option("--password-stdin", "read Overleaf password from stdin")
  .option("--insecure", "disable TLS verification")
  .action(async (options) => {
    await authLogin(options);
  });

auth
  .command("status")
  .description("check a saved session")
  .option("--platform <name>", "known platform: cstcloud or overleaf")
  .option("--host <url>", "custom Overleaf host")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .option("--insecure", "disable TLS verification")
  .action(async (options) => {
    const target = await resolveAuthTarget(options);
    const session = await loadSession(target.sessionFile, target.host);
    const sslVerify = options.insecure ? false : session.sslVerify;
    const status = await checkSession({ host: target.host, session: { ...session, sslVerify } });
    if (!status.loggedIn) throw new TexleafError(`Not logged in to ${target.host}: ${status.error ?? "unknown error"}`);
    console.log(`Logged in to ${target.host} as ${status.email ?? status.userId ?? "unknown user"}`);
  });

auth
  .command("logout")
  .description("delete a saved session")
  .option("--platform <name>", "known platform: cstcloud or overleaf")
  .option("--host <url>", "custom Overleaf host")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .action(async (options) => {
    const target = await resolveAuthTarget(options);
    await fs.rm(target.sessionFile, { force: true });
    console.log(`Deleted session ${target.sessionFile}`);
  });

program.parseAsync(normalizeCloneArgs(process.argv)).catch((error: unknown) => {
  if (error instanceof TexleafError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error) console.error(`Unexpected failure: ${error.message}`);
  else console.error(`Unexpected failure: ${String(error)}`);
  process.exitCode = 1;
});

async function authLogin(options: Record<string, any>): Promise<void> {
  const passwordMode = Boolean(options.email);
  if (options.password && options.passwordStdin) throw new TexleafError("Use only one password input method.");
  if (!passwordMode && (options.password || options.passwordStdin)) {
    throw new TexleafError("Use --password or --password-stdin only with --email.");
  }
  const interactive = !passwordMode;
  const target = interactive ? await interactiveAuthTarget(options) : await resolveAuthTarget(options, true);
  const sslVerify = options.insecure ? false : !platformDisablesTls(target.platform, target.host);
  const profile = options.profile ?? "default";
  const session = passwordMode
    ? await loginWithPassword({
        host: target.host,
        profile,
        email: options.email,
        password: await passwordFromOptions(options),
        sslVerify
      })
    : await interactiveSession(target, sslVerify, profile);
  await saveSession(target.sessionFile, session);
  console.log(`Saved session to ${target.sessionFile}`);
}

async function resolveAuthTarget(options: Record<string, any>, allowDefaultKnown = false): Promise<AuthTarget> {
  const profile = options.profile ?? "default";
  const platform = await resolvePlatform(options.platform, options.host, profile, allowDefaultKnown);
  const host = options.host ? normalizeHost(options.host) : platform !== "custom" ? platformHost(platform) : await configHost();
  const resolvedPlatform = platform === "custom" ? hostPlatform(host) : platform;
  const sessionFile =
    options.sessionFile ??
    (resolvedPlatform !== "custom" ? globalSessionFile(resolvedPlatform, profile) : path.resolve(".texleaf/session.json"));
  return { host, platform: resolvedPlatform, sessionFile };
}

async function interactiveAuthTarget(options: Record<string, any>): Promise<AuthTarget> {
  if (options.platform || options.host) return await resolveAuthTarget(options, true);
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Choose Overleaf platform:");
    console.log("  1. cstcloud (https://latex.cstcloud.cn)");
    console.log("  2. overleaf (https://www.overleaf.com)");
    console.log("  3. custom host");
    const choice = (await rl.question("Platform [1]: ")).trim() || "1";
    if (choice === "3") {
      const host = normalizeHost(await rl.question("Overleaf host: "));
      return {
        host,
        platform: hostPlatform(host),
        sessionFile: options.sessionFile ?? path.resolve(".texleaf/session.json")
      };
    }
    const platform = choice === "2" ? "overleaf" : "cstcloud";
    return {
      host: platformHost(platform),
      platform,
      sessionFile: options.sessionFile ?? globalSessionFile(platform, options.profile ?? "default")
    };
  } finally {
    rl.close();
  }
}

async function resolvePlatform(
  rawPlatform: string | undefined,
  rawHost: string | undefined,
  profile: string,
  allowDefaultKnown = true
): Promise<PlatformName | "custom"> {
  if (rawPlatform && !isPlatformName(rawPlatform)) {
    throw new TexleafError(`Unknown platform: ${rawPlatform}. Use one of: ${Object.keys(platforms).join(", ")}`);
  }
  if (rawPlatform && rawHost) throw new TexleafError("Use only one of --platform or --host.");
  if (rawPlatform) return rawPlatform as PlatformName;
  if (rawHost) return hostPlatform(rawHost);
  const config = await loadConfig(process.cwd()).catch(() => undefined);
  if (config) return config.project.platform;
  if (allowDefaultKnown) {
    const sessions = await Promise.all(
      (Object.keys(platforms) as PlatformName[]).map(async (platform) => ({
        platform,
        exists: await exists(globalSessionFile(platform, profile))
      }))
    );
    const found = sessions.filter((session) => session.exists);
    if (found.length === 1) return found[0].platform;
  }
  throw new TexleafError("Pass --platform or --host, or run `texleaf auth login` first.");
}

async function configHost(): Promise<string> {
  const config = await loadConfig(process.cwd()).catch(() => undefined);
  if (!config) throw new TexleafError("Pass --host for custom sessions outside a texleaf project.");
  return config.project.host;
}

async function promptCookieHeader(platform: PlatformName | "custom"): Promise<string> {
  if (!process.stdin.isTTY) throw new TexleafError("Cookie login is interactive; run it in a terminal.");
  const cookieNames = platformCookieNames(platform);
  const rl = readline.createInterface({ input, output });
  try {
    if (!cookieNames.length) return (await rl.question("Cookie header: ")).trim();
    const pairs: string[] = [];
    for (const name of cookieNames) {
      const value = (await rl.question(`${name}: `)).trim();
      if (!value) throw new TexleafError(`${name} cookie value is required.`);
      pairs.push(`${name}=${value}`);
    }
    return pairs.join("; ");
  } finally {
    rl.close();
  }
}

async function cookieLoginSession(target: AuthTarget, sslVerify: boolean, profile: string) {
  const cookieHeader = await promptCookieHeader(target.platform);
  const session = sessionFromCookieHeader({
    host: target.host,
    profile,
    cookieHeader,
    sslVerify
  });
  const status = await checkSession({ host: target.host, session });
  if (!status.loggedIn) throw new TexleafError(`Cookie session is not logged in to ${target.host}: ${status.error ?? "unknown error"}`);
  return session;
}

async function interactiveSession(target: AuthTarget, sslVerify: boolean, profile: string): Promise<AuthSession> {
  if (target.platform !== "custom") return await cookieLoginSession(target, sslVerify, profile);
  const email = await promptOptional("Overleaf email (leave empty to paste Cookie header): ");
  if (!email) return await cookieLoginSession(target, sslVerify, profile);
  return await loginWithPassword({
    host: target.host,
    profile,
    email,
    password: await promptPassword(),
    sslVerify
  });
}

async function passwordFromOptions(options: Record<string, any>): Promise<string> {
  if (options.password) {
    warn("--password can expose credentials in process listings; prefer the prompt or --password-stdin.");
    return options.password;
  }
  if (options.passwordStdin) return await readStdin("password");
  return await promptPassword();
}

async function readStdin(label: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new TexleafError(`No ${label} was provided on standard input.`);
  return value;
}

async function promptOptional(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new TexleafError("Interactive login must be run in a terminal.");
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new TexleafError("Pass --password-stdin when standard input is not interactive.");
  warn("For scripted login, prefer --password-stdin so the password is not exposed in process listings.");
  const rl = readline.createInterface({ input, output });
  try {
    const password = await rl.question("Overleaf password: ");
    if (!password) throw new TexleafError("Password is required.");
    return password;
  } finally {
    rl.close();
  }
}

function normalizeCloneArgs(argv: string[]): string[] {
  if (argv[2] !== "clone") return argv;
  const normalized = [...argv];
  for (let index = 3; index < normalized.length; index++) {
    const arg = normalized[index];
    if (arg === "--project-id") {
      const value = normalized[index + 1];
      if (!value || value.startsWith("-")) return argv;
      normalized.splice(index, 2, value);
      return normalized;
    }
    if (arg.startsWith("--project-id=")) {
      normalized.splice(index, 1, arg.slice("--project-id=".length));
      return normalized;
    }
  }
  return argv;
}

interface AuthTarget {
  host: string;
  platform: PlatformName | "custom";
  sessionFile: string;
}

#!/usr/bin/env node
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { Command } from "commander";

import { type AuthSession, checkSession, loginWithPassword, saveSession, sessionFromCookieHeader } from "./auth.js";
import { type AuthTarget, chooseAuthTarget } from "./auth-menu.js";
import { loginWithChrome } from "./chrome.js";
import { loadConfig, resolveRepoPath } from "./config.js";
import { TexleafError } from "./errors.js";
import { exists } from "./files.js";
import { info, warn } from "./log.js";
import {
  type ProjectLocator,
  type PlatformName,
  globalSessionFile,
  hostPlatform,
  isPlatformName,
  normalizeHost,
  parseProjectLocator,
  platformCookieNames,
  platformDisablesTls,
  platformHost,
  platforms
} from "./platform.js";
import { SyncEngine } from "./sync.js";
import { ensureSession } from "./session.js";

const program = new Command();

// Commander passes plain option bags; describe the shape each command accepts.
interface GlobalOptions {
  platform?: string;
  host?: string;
  profile?: string;
  sessionFile?: string;
  insecure?: boolean;
}

interface PasswordOptions {
  password?: string;
  passwordStdin?: boolean;
}

interface ChromeOptions {
  fromChrome?: boolean;
  chromeProfile?: string;
}

type AuthLoginOptions = GlobalOptions & PasswordOptions & ChromeOptions & { email?: string };
type CloneCommandOptions = GlobalOptions & { projectName?: string; force?: boolean };

program.name("texleaf").description("Git-safe Overleaf and TexPage project sync CLI").version(packageVersion());

// Read the version from package.json so releases cannot drift from it.
function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

program
  .command("clone")
  .description("download a remote project into a new local Git repository")
  .option("--platform <name>", "known platform: cstcloud, overleaf, or texpage")
  .option("--host <url>", "custom project host")
  .option("--project-name <name>", "override local project name")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .option("--force", "allow cloning into a non-empty directory")
  .option("--insecure", "disable TLS verification")
  .argument("<project>", "project id or project URL")
  .argument("[directory]", "destination directory")
  .action(async (project: string, directory: string | undefined, options: CloneCommandOptions) => {
    const locator = parseProjectLocator(project);
    const host = resolveCloneHost(locator, options);
    const platform = await resolveClonePlatform(locator, options, host);
    if (locator.host) {
      info(`Resolved project URL: host=${host}, platform=${platform}, projectId=${locator.projectId}`);
    }
    const target = await new SyncEngine(process.cwd()).clone({
      host,
      platform,
      projectId: locator.projectId,
      versionNo: locator.versionNo,
      projectName: options.projectName,
      directory,
      profile: options.profile ?? "default",
      sessionFile: options.sessionFile,
      force: Boolean(options.force),
      insecure: Boolean(options.insecure)
    });
    console.log(`Cloned project to ${target}`);
  });

program
  .command("pull")
  .description("import latest remote snapshot through Git")
  .action(async () => {
    await new SyncEngine(process.cwd()).pull();
  });

program
  .command("push")
  .description("apply committed local changes to the remote project")
  .option("--dry-run", "print the push plan without writing")
  .action(async (options: { dryRun?: boolean }) => {
    await new SyncEngine(process.cwd()).push(Boolean(options.dryRun));
  });

program
  .command("status")
  .description("show local sync status")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    await new SyncEngine(process.cwd()).status(Boolean(options.json));
  });

program
  .command("verify")
  .description("compare latest remote snapshot with local files")
  .option("--allow-diff", "exit zero when differences are found")
  .action(async (options: { allowDiff?: boolean }) => {
    await new SyncEngine(process.cwd()).verify(Boolean(options.allowDiff));
  });

const auth = program.command("auth").description("manage saved project service sessions");

auth
  .command("login")
  .description("save a reusable project service session")
  .option("--platform <name>", "known platform: cstcloud, overleaf, or texpage")
  .option("--host <url>", "custom project host")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .option("--email <email>", "email for password login")
  .option("--password <password>", "account password")
  .option("--password-stdin", "read account password from stdin")
  .option("--from-chrome", "import Chrome cookies (macOS; checks all platforms unless --platform/--host is set)")
  .option("--chrome-profile <directory>", "Chrome profile name or path (requires --from-chrome)")
  .option("--insecure", "disable TLS verification")
  .action(async (options: AuthLoginOptions) => {
    await authLogin(options);
  });

auth
  .command("status")
  .description("check a saved session and refresh it from Chrome if needed")
  .option("--platform <name>", "known platform: cstcloud, overleaf, or texpage")
  .option("--host <url>", "custom project host")
  .option("--profile <name>", "auth profile (defaults to the project's profile)")
  .option("--session-file <file>", "session JSON file")
  .option("--insecure", "disable TLS verification")
  .action(async (options: GlobalOptions) => {
    const config =
      !options.platform && !options.host ? await loadConfig(process.cwd()).catch(() => undefined) : undefined;
    const profile = options.profile ?? config?.auth.profile ?? "default";
    const projectSession = config && profile === config.auth.profile;
    const target = projectSession
      ? {
          host: config.project.host,
          sessionFile: options.sessionFile ?? resolveRepoPath(process.cwd(), config.auth.sessionFile)
        }
      : await resolveAuthTarget({ ...options, profile });
    const { status } = await ensureSession({
      host: target.host,
      profile,
      sessionFile: target.sessionFile,
      sslVerify: options.insecure ? false : projectSession ? config.backend.sslVerify : undefined
    });
    console.log(`Logged in to ${target.host} as ${status.email ?? status.userId ?? "unknown user"}`);
  });

auth
  .command("logout")
  .description("delete a saved session")
  .option("--platform <name>", "known platform: cstcloud, overleaf, or texpage")
  .option("--host <url>", "custom project host")
  .option("--profile <name>", "auth profile", "default")
  .option("--session-file <file>", "session JSON file")
  .action(async (options: GlobalOptions) => {
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

async function authLogin(options: AuthLoginOptions): Promise<void> {
  const email = options.email?.trim();
  const passwordMode = Boolean(email);
  if (options.fromChrome && (passwordMode || options.password || options.passwordStdin)) {
    throw new TexleafError("Use --from-chrome separately from password login options.");
  }
  if (options.chromeProfile && !options.fromChrome) {
    throw new TexleafError("Use --chrome-profile only with --from-chrome.");
  }
  if (options.password && options.passwordStdin) throw new TexleafError("Use only one password input method.");
  if (!passwordMode && (options.password || options.passwordStdin)) {
    throw new TexleafError("Use --password or --password-stdin only with --email.");
  }
  const useMenu = !passwordMode && !options.platform && !options.host;
  const target = useMenu
    ? await chooseAuthTarget(options, {
        question: promptOptional,
        write: console.log,
        interactive: Boolean(process.stdin.isTTY)
      })
    : await resolveAuthTarget(options, true);
  if (!target) return;
  if (target.platform === "texpage" && passwordMode) {
    throw new TexleafError(
      "TexPage uses Cookie sessions; use --from-chrome or log in with the TexPage SESSIONID cookie."
    );
  }
  const sslVerify = options.insecure ? false : !platformDisablesTls(target.platform, target.host);
  const profile = options.profile ?? "default";
  if (options.fromChrome && !useMenu) {
    info(`Reading Chrome session cookies for ${target.host}; macOS may ask for Chrome Safe Storage Keychain access.`);
    const imported = await loginWithChrome({
      host: target.host,
      profile,
      chromeProfile: options.chromeProfile,
      sslVerify
    });
    await saveSession(target.sessionFile, imported.session);
    console.log(
      `Imported Chrome profile ${JSON.stringify(imported.chromeProfile)}. Saved session to ${target.sessionFile}`
    );
    return;
  }
  const session =
    passwordMode && email
      ? await loginWithPassword({
          host: target.host,
          profile,
          email,
          password: await passwordFromOptions(options),
          sslVerify
        })
      : await interactiveSession(target, sslVerify, profile);
  await saveSession(target.sessionFile, session);
  console.log(`Saved session to ${target.sessionFile}`);
}

function resolveCloneHost(locator: ProjectLocator, options: { host?: string }): string | undefined {
  const explicitHost = options.host ? normalizeHost(options.host) : undefined;
  if (!locator.host) return explicitHost;
  if (explicitHost && explicitHost !== locator.host) {
    throw new TexleafError(
      `Project URL host ${locator.host} conflicts with --host ${explicitHost}. Omit --host or use the same host.`
    );
  }
  return locator.host;
}

async function resolveClonePlatform(
  locator: ProjectLocator,
  options: { platform?: string; profile?: string },
  host: string | undefined
): Promise<PlatformName | "custom"> {
  if (!locator.host) return await resolvePlatform(options.platform, host, options.profile ?? "default");
  if (options.platform) {
    if (!isPlatformName(options.platform)) {
      throw new TexleafError(`Unknown platform: ${options.platform}. Use one of: ${Object.keys(platforms).join(", ")}`);
    }
    if (locator.platform === "custom" || options.platform !== locator.platform) {
      throw new TexleafError(
        `Project URL resolves to platform ${locator.platform}; omit --platform or use the matching platform.`
      );
    }
  }
  return locator.platform ?? hostPlatform(locator.host);
}

async function resolveAuthTarget(options: GlobalOptions, allowDefaultKnown = false): Promise<AuthTarget> {
  const profile = options.profile ?? "default";
  const platform = await resolvePlatform(options.platform, options.host, profile, allowDefaultKnown);
  const host = options.host
    ? normalizeHost(options.host)
    : platform !== "custom"
      ? platformHost(platform)
      : await configHost();
  const resolvedPlatform = platform === "custom" ? hostPlatform(host) : platform;
  const sessionFile =
    options.sessionFile ??
    (resolvedPlatform !== "custom"
      ? globalSessionFile(resolvedPlatform, profile)
      : path.resolve(".texleaf/session.json"));
  return { host, platform: resolvedPlatform, sessionFile };
}

async function resolvePlatform(
  rawPlatform: string | undefined,
  rawHost: string | undefined,
  profile: string | undefined,
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
  if (!status.loggedIn)
    throw new TexleafError(`Cookie session is not logged in to ${target.host}: ${status.error ?? "unknown error"}`);
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

async function passwordFromOptions(options: PasswordOptions): Promise<string> {
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
  // readline echoes the answer, which would leave the password on screen and in
  // the terminal scrollback; read it without echo instead.
  const password = await promptSecret("Overleaf password: ");
  if (!password) throw new TexleafError("Password is required.");
  return password;
}

function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    const stream = process.stdin;
    const decoder = new StringDecoder("utf8");
    const wasRaw = stream.isRaw ?? false;
    let value = "";
    const finish = (next: () => void) => {
      stream.off("data", onData);
      stream.setRawMode(wasRaw);
      stream.pause();
      process.stderr.write("\n");
      next();
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const char of text) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003" || char === "\u0004") return finish(() => reject(new TexleafError("Cancelled.")));
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stream.setRawMode(true);
    stream.resume();
    stream.on("data", onData);
  });
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

import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type AuthSession, type AuthStatus, checkSession } from "./auth.js";
import { AuthError, ConfigError } from "./errors.js";
import { exists } from "./files.js";
import { hostPlatform, normalizeHost, platformCookieNames } from "./platform.js";

const execFileAsync = promisify(execFile);
const manualLoginHint = "Run `texleaf auth login` without --from-chrome to paste cookies manually.";

// Chromium derives the cookie encryption key from the Safe Storage password.
const cookieKeySalt = "saltysalt";
const cookieKeyIterations = 1003;
const cookieKeyBytes = 16;
// Cookie expiry is stored as microseconds since 1601-01-01 (the Windows epoch).
const windowsEpochOffsetMs = 11_644_473_600_000n;
const microsecondsPerMillisecond = 1_000n;
const sqliteTimeoutMs = 5_000;
const keychainTimeoutMs = 60_000;

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: string;
  path: string;
  is_secure: number;
  version: number;
}

interface ChromeAccess {
  platform: NodeJS.Platform;
  userDataDir: string;
  readCookies: typeof readChromeCookieRows;
  readPassword: () => Promise<string>;
}

export interface ChromeLoginOptions {
  host: string;
  profile: string;
  chromeProfile?: string;
  sslVerify: boolean;
  timeoutMs?: number;
}

function defaultChromeAccess(): ChromeAccess {
  return {
    platform: process.platform,
    userDataDir: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    readCookies: readChromeCookieRows,
    readPassword: readChromePassword
  };
}

// Share one Keychain request across a batch, including a denied request. A new
// batch creates a new importer so the user can retry after granting access.
export function createChromeLogin(access: ChromeAccess = defaultChromeAccess()) {
  let password: Promise<string> | undefined;
  const batchAccess = { ...access, readPassword: () => (password ??= access.readPassword()) };
  return (args: ChromeLoginOptions) => loginWithChrome(args, batchAccess);
}

export async function loginWithChrome(
  args: ChromeLoginOptions,
  access: ChromeAccess = defaultChromeAccess()
): Promise<{ session: AuthSession; chromeProfile: string; status: AuthStatus }> {
  if (access.platform !== "darwin") {
    throw new AuthError(`Chrome cookie import currently supports macOS only. ${manualLoginHint}`);
  }
  const host = normalizeHost(args.host);
  const url = new URL(host);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError("Chrome cookie import requires an HTTP(S) host without credentials, query, or fragment.");
  }
  const profiles = await chromeProfiles(access.userDataDir, args.chromeProfile);
  const names = platformCookieNames(hostPlatform(host));
  const candidates: { profile: string; rows: ChromeCookieRow[] }[] = [];
  for (const profile of profiles) {
    // Current Chrome versions use Network/Cookies; older profiles use Cookies.
    const databases = [path.join(profile, "Network", "Cookies"), path.join(profile, "Cookies")];
    for (const database of databases) {
      if (!(await exists(database))) continue;
      const rows = await access.readCookies(database, url, names);
      if (rows.length) candidates.push({ profile, rows });
      break;
    }
  }
  if (!candidates.length) {
    throw new AuthError(
      `No saved Chrome session cookies found for ${host}. Log in to this site in Chrome, then retry; if needed, quit Chrome so it saves its cookies. ${manualLoginHint}`
    );
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ profile }) => JSON.stringify(path.basename(profile))).join(", ");
    throw new AuthError(
      `Cookies for ${host} exist in multiple Chrome profiles: ${choices}. Choose one with --chrome-profile <directory>.`
    );
  }
  const candidate = candidates[0];
  // Do not access the Keychain until a single profile with matching cookies is selected.
  const encrypted = candidate.rows.some((row) => row.encrypted_value.length > 0);
  const key = encrypted
    ? pbkdf2Sync(await access.readPassword(), cookieKeySalt, cookieKeyIterations, cookieKeyBytes, "sha1")
    : undefined;
  let session: AuthSession;
  try {
    session = {
      host,
      profile: args.profile,
      chromeProfile: candidate.profile,
      sslVerify: args.sslVerify,
      createdAt: new Date().toISOString(),
      cookies: candidate.rows.map((row) => {
        const value = decryptCookie(row, key);
        // eslint-disable-next-line no-control-regex -- cookie values must not carry control characters
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(row.name) || /[\x00-\x20\x7f;]/.test(value)) {
          throw new AuthError("Chrome returned an invalid cookie. Log in again in Chrome and retry.");
        }
        return { name: row.name, value, domain: row.host_key, path: row.path, secure: Boolean(row.is_secure) };
      })
    };
  } finally {
    key?.fill(0);
  }
  const status = await checkSession({ host, session, timeoutMs: args.timeoutMs });
  if (!status.loggedIn) {
    throw new AuthError(
      `Chrome session is not logged in to ${host}. Log in again in the selected Chrome profile and retry. ${manualLoginHint}`
    );
  }
  return { session, chromeProfile: path.basename(candidate.profile), status };
}

async function chromeProfiles(userDataDir: string, selected?: string): Promise<string[]> {
  if (selected) {
    const profile = selected.startsWith("~/")
      ? path.join(os.homedir(), selected.slice(2))
      : path.isAbsolute(selected) || selected.includes("/")
        ? path.resolve(selected)
        : path.join(userDataDir, selected);
    return [profile];
  }
  try {
    const entries = await fs.readdir(userDataDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
      .map((entry) => path.join(userDataDir, entry.name))
      .sort();
  } catch {
    throw new AuthError(
      `Could not find Chrome profiles. Open Chrome first, or pass --chrome-profile with a profile directory path. ${manualLoginHint}`
    );
  }
}

export async function readChromeCookieRows(database: string, url: URL, names: string[]): Promise<ChromeCookieRow[]> {
  const domains = [url.hostname, `.${url.hostname}`];
  if (!isIP(url.hostname)) {
    const labels = url.hostname.split(".");
    for (let index = 1; index < labels.length - 1; index++) domains.push(`.${labels.slice(index).join(".")}`);
  }
  // Only import cookies that apply to the application's base path. A /project-only
  // cookie must not be sent to /user/personal_info or other endpoints by the CLI.
  const basePath = url.pathname.replace(/\/+$/, "") || "/";
  const now = (BigInt(Date.now()) + windowsEpochOffsetMs) * microsecondsPerMillisecond;
  try {
    const columns = await sqliteJson<{ name: string }>(database, "SELECT name FROM pragma_table_info('cookies');");
    const partitionFilter = columns.some((column) => column.name === "top_frame_site_key")
      ? "AND top_frame_site_key = ''"
      : "";
    const rows = await sqliteJson<ChromeCookieRow>(
      database,
      `
      SELECT host_key, name, value, hex(encrypted_value) AS encrypted_value, path, is_secure,
        (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version') AS version
      FROM cookies
      WHERE host_key IN (${domains.map(sqlString).join(", ")})
        ${names.length ? `AND name IN (${names.map(sqlString).join(", ")})` : ""}
        AND (has_expires = 0 OR expires_utc > ${now})
        ${url.protocol === "https:" ? "" : "AND is_secure = 0"}
        ${partitionFilter}
      ORDER BY length(path) DESC, creation_utc ASC;
    `
    );
    return rows.filter(
      (row) => basePath === row.path || basePath.startsWith(row.path.endsWith("/") ? row.path : `${row.path}/`)
    );
  } catch {
    // Child-process errors may contain captured stdout, including cookie values.
    throw new AuthError(
      `Could not read Chrome's cookie database. Quit Chrome and retry; macOS must provide /usr/bin/sqlite3 and allow access to the profile. ${manualLoginHint}`
    );
  }
}

async function sqliteJson<T>(database: string, query: string): Promise<T[]> {
  const { stdout } = await execFileAsync(
    "/usr/bin/sqlite3",
    ["-init", "/dev/null", "-readonly", "-batch", "-json", "-cmd", ".timeout 1500", database, query],
    { encoding: "utf8", timeout: sqliteTimeoutMs, maxBuffer: 1024 * 1024 }
  );
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readChromePassword(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      { encoding: "utf8", timeout: keychainTimeoutMs, maxBuffer: 16 * 1024 }
    );
    const password = stdout.replace(/\r?\n$/, "");
    if (!password) throw new Error("Empty Keychain item");
    return password;
  } catch {
    throw new AuthError(
      `Could not access Chrome Safe Storage in macOS Keychain. Allow access when prompted and retry. ${manualLoginHint}`
    );
  }
}

function decryptCookie(row: ChromeCookieRow, key?: Buffer): string {
  if (!row.encrypted_value) return row.value;
  const encrypted = Buffer.from(row.encrypted_value, "hex");
  if (encrypted.subarray(0, 3).toString("ascii") !== "v10") {
    throw new AuthError(`Unsupported Chrome cookie encryption format. ${manualLoginHint}`);
  }
  if (!key || !Number.isInteger(row.version) || row.version < 1) {
    throw new AuthError("Could not determine Chrome's cookie encryption key or database version.");
  }
  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    throw new AuthError(`Could not decrypt Chrome cookies using macOS Keychain. ${manualLoginHint}`);
  }
  try {
    // Since database version 24, Chromium encrypts SHA256(host_key) before the value.
    if (row.version >= 24) {
      const expected = createHash("sha256").update(row.host_key).digest();
      if (!decrypted.subarray(0, 32).equals(expected)) {
        throw new AuthError("Chrome cookie domain verification failed. Log in again in Chrome and retry.");
      }
      return decrypted.subarray(32).toString("utf8");
    }
    return decrypted.toString("utf8");
  } finally {
    decrypted.fill(0);
  }
}

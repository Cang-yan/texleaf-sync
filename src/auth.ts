import { URL } from "node:url";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";

import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { AuthError, ConfigError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { hostPlatform, normalizeHost } from "./platform.js";

// HTTP types come from undici, the implementation actually used at runtime.
export type HttpResponse = UndiciResponse;
export type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}

export interface AuthSession {
  host: string;
  profile: string;
  cookies: StoredCookie[];
  createdAt: string;
  /** Absent in sessions written by older versions; treat that as verified. */
  sslVerify?: boolean;
  /** Chrome directory used to import this session, for later automatic refresh. */
  chromeProfile?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  userId?: string;
  error?: string;
  /** The server rejected authentication, rather than failing to respond. */
  authRequired?: boolean;
}

export function cookieDomain(host: string): string {
  const parsed = new URL(normalizeHost(host));
  if (!parsed.hostname) throw new ConfigError(`Invalid Overleaf host: ${host}`);
  return parsed.hostname;
}

export function sessionFromCookieHeader(args: {
  host: string;
  profile: string;
  cookieHeader: string;
  sslVerify: boolean;
}): AuthSession {
  const cookies: StoredCookie[] = [];
  const domain = cookieDomain(args.host);
  for (const pair of args.cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) throw new ConfigError(`Invalid cookie pair: ${trimmed}`);
    cookies.push({
      name: trimmed.slice(0, equals),
      value: trimmed.slice(equals + 1),
      domain,
      path: "/",
      secure: normalizeHost(args.host).startsWith("https:")
    });
  }
  if (!cookies.length) throw new ConfigError("No cookies were provided.");
  return {
    host: normalizeHost(args.host),
    profile: args.profile,
    cookies,
    createdAt: new Date().toISOString(),
    sslVerify: args.sslVerify
  };
}

export async function saveSession(file: string, session: AuthSession): Promise<void> {
  await writeJsonAtomic(file, session, 0o600);
}

export async function loadSession(file: string, expectedHost?: string): Promise<AuthSession> {
  const session = await readJson<AuthSession>(file);
  if (expectedHost && !hostsMatch(session.host, expectedHost)) {
    throw new AuthError(`Session host ${session.host} does not match ${normalizeHost(expectedHost)}.`);
  }
  return session;
}

export function cookieHeader(session: AuthSession): string {
  return session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function checkSession(args: {
  host: string;
  session: AuthSession;
  timeoutMs?: number;
}): Promise<AuthStatus> {
  try {
    if (hostPlatform(args.host) === "texpage") {
      const response = await fetchWithTimeout(`${normalizeHost(args.host)}/api/project/total?t=${Date.now()}`, {
        headers: {
          Accept: "application/json",
          Cookie: cookieHeader(args.session)
        },
        redirect: "manual",
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        sslVerify: args.session.sslVerify !== false
      });
      if (response.status !== 200) return rejectedSessionStatus(response.status);
      const data = (await response.json()) as { status?: { code?: unknown } };
      if (data.status?.code !== 1) {
        return {
          loggedIn: false,
          error: "TexPage session was rejected.",
          authRequired: typeof data.status?.code === "number"
        };
      }
      return { loggedIn: true };
    }
    const response = await fetchWithTimeout(`${normalizeHost(args.host)}/user/personal_info`, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader(args.session)
      },
      redirect: "manual",
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      sslVerify: args.session.sslVerify !== false
    });
    if (response.status !== 200) return rejectedSessionStatus(response.status);
    const data = (await response.json()) as Record<string, unknown>;
    return {
      loggedIn: true,
      email: typeof data.email === "string" ? data.email : undefined,
      userId: typeof data._id === "string" ? data._id : typeof data.id === "string" ? data.id : undefined
    };
  } catch (error) {
    return { loggedIn: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function rejectedSessionStatus(status: number): AuthStatus {
  return {
    loggedIn: false,
    error: `HTTP ${status}`,
    authRequired: status === 401 || status === 403 || (status >= 300 && status < 400)
  };
}

export async function loginWithPassword(args: {
  host: string;
  profile: string;
  email: string;
  password: string;
  sslVerify: boolean;
  timeoutMs?: number;
}): Promise<AuthSession> {
  const host = normalizeHost(args.host);
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loginPage = await fetchWithTimeout(`${host}/login`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    redirect: "manual",
    timeoutMs,
    sslVerify: args.sslVerify
  });
  if (loginPage.status >= 300) {
    throw new AuthError(`Could not open Overleaf login page: HTTP ${loginPage.status}`);
  }
  const cookies = mergeSetCookies(new Map(), loginPage.headers.getSetCookie(), host);
  const csrf = extractCsrfToken(await loginPage.text());
  const response = await fetchWithTimeout(`${host}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded",
      Referer: `${host}/login`,
      Cookie: cookiesToHeader(cookies)
    },
    body: new URLSearchParams({ email: args.email, password: args.password, _csrf: csrf }),
    redirect: "manual",
    timeoutMs,
    sslVerify: args.sslVerify
  });
  if (response.status >= 400) {
    throw new AuthError("Overleaf login failed. Check credentials, captcha settings, and server logs.");
  }
  mergeSetCookies(cookies, response.headers.getSetCookie(), host);
  const session: AuthSession = {
    host,
    profile: args.profile,
    cookies: [...cookies.values()],
    createdAt: new Date().toISOString(),
    sslVerify: args.sslVerify
  };
  const status = await checkSession({ host, session, timeoutMs });
  if (!status.loggedIn) throw new AuthError("Overleaf login did not produce a valid logged-in session.");
  return session;
}

export async function fetchWithTimeout(
  url: string,
  init: FetchInit & { timeoutMs: number; sslVerify?: boolean }
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  const { timeoutMs: _timeoutMs, sslVerify, ...requestInit } = init;
  // Only an explicit false turns verification off; a missing value from an old
  // session file must not silently downgrade to an insecure connection.
  const dispatcher = sslVerify === false ? insecureTlsAgent() : undefined;
  try {
    return await undiciFetch(url, { ...requestInit, dispatcher, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One agent for every insecure request: building one per call leaks sockets.
let sharedInsecureAgent: Agent | undefined;

function insecureTlsAgent(): Agent {
  return (sharedInsecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } }));
}

export function extractCsrfToken(html: string): string {
  const match =
    html.match(/<meta[^>]+name=["']ol-csrfToken["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']ol-csrfToken["']/i);
  if (!match) throw new AuthError("Could not find the Overleaf CSRF token in the returned page.");
  return match[1];
}

function mergeSetCookies(
  cookies: Map<string, StoredCookie>,
  headers: string[],
  host: string
): Map<string, StoredCookie> {
  for (const header of headers) {
    const cookie = parseSetCookie(header, host);
    if (!cookie) continue;
    cookies.set(`${cookie.domain}\n${cookie.path}\n${cookie.name}`, cookie);
  }
  return cookies;
}

function parseSetCookie(header: string, host: string): StoredCookie | undefined {
  const parts = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const [nameValue, ...attributes] = parts;
  if (!nameValue) return undefined;
  const equals = nameValue.indexOf("=");
  if (equals <= 0) return undefined;
  const normalizedHost = normalizeHost(host);
  const cookie: StoredCookie = {
    name: nameValue.slice(0, equals),
    value: nameValue.slice(equals + 1),
    domain: cookieDomain(normalizedHost),
    path: "/",
    secure: normalizedHost.startsWith("https:")
  };
  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join("=").trim();
    if (key === "domain" && value) cookie.domain = value.replace(/^\./, "");
    else if (key === "path" && value) cookie.path = value;
    else if (key === "secure") cookie.secure = true;
  }
  return cookie;
}

function cookiesToHeader(cookies: Map<string, StoredCookie>): string {
  return [...cookies.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function hostsMatch(savedHost: string, expectedHost: string): boolean {
  const saved = normalizeHost(savedHost);
  const expected = normalizeHost(expectedHost);
  if (saved === expected) return true;
  const savedPlatform = hostPlatform(saved);
  return savedPlatform !== "custom" && savedPlatform === hostPlatform(expected);
}

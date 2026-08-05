import { URL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

import { AuthError, ConfigError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { normalizeHost } from "./platform.js";

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
  sslVerify: boolean;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  userId?: string;
  error?: string;
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
  if (expectedHost && normalizeHost(session.host) !== normalizeHost(expectedHost)) {
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
    const response = await fetchWithTimeout(`${normalizeHost(args.host)}/user/personal_info`, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader(args.session)
      },
      redirect: "manual",
      timeoutMs: args.timeoutMs ?? 16_000,
      sslVerify: args.session.sslVerify
    });
    if (response.status !== 200) return { loggedIn: false, error: `HTTP ${response.status}` };
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

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number; sslVerify: boolean }
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  const { timeoutMs: _timeoutMs, sslVerify, ...requestInit } = init;
  const dispatcher = sslVerify ? undefined : new Agent({ connect: { rejectUnauthorized: false } });
  try {
    return (await undiciFetch(url, {
      ...requestInit,
      dispatcher,
      signal: controller.signal
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } finally {
    clearTimeout(timer);
  }
}

export function extractCsrfToken(html: string): string {
  const match = html.match(/<meta[^>]+name=["']ol-csrfToken["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']ol-csrfToken["']/i);
  if (!match) throw new AuthError("Could not find Overleaf CSRF token in project page.");
  return match[1];
}

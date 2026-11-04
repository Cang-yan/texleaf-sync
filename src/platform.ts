import os from "node:os";
import path from "node:path";

import { ConfigError } from "./errors.js";

export const platforms = {
  cstcloud: {
    host: "https://latex.cstcloud.cn",
    aliases: [],
    cookieNames: ["latex-session", "overleaf.sid"],
    insecureTls: true
  },
  overleaf: {
    host: "https://www.overleaf.com",
    aliases: ["https://cn.overleaf.com"],
    cookieNames: ["overleaf_session2"],
    insecureTls: false
  },
  texpage: {
    host: "https://www.texpage.com",
    aliases: [],
    cookieNames: ["SESSIONID"],
    insecureTls: false,
    socketUrl: "wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket"
  }
} as const;

export type PlatformName = keyof typeof platforms;

export function isPlatformName(value: string | undefined): value is PlatformName {
  return value !== undefined && Object.hasOwn(platforms, value);
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) throw new ConfigError("Overleaf host is required.");
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function hostPlatform(host: string): PlatformName | "custom" {
  const normalized = normalizeHost(host);
  for (const [name, platform] of Object.entries(platforms)) {
    if (normalizeHost(platform.host) === normalized) return name as PlatformName;
    if (platform.aliases.some((alias) => normalizeHost(alias) === normalized)) return name as PlatformName;
  }
  return "custom";
}

export function platformHost(platform: PlatformName): string {
  return platforms[platform].host;
}

export function platformCookieNames(platform: PlatformName | "custom"): string[] {
  return platform === "custom" ? [] : [...platforms[platform].cookieNames];
}

export function platformDisablesTls(platform: PlatformName | "custom", host: string): boolean {
  if (platform !== "custom") return platforms[platform].insecureTls;
  return hostPlatform(host) === "cstcloud";
}

// Realtime endpoint for platforms that serve sockets from a separate host.
// Custom hosts derive it from the configured host instead of assuming a vendor
// domain, so self-hosted deployments keep working.
export function platformSocketUrl(platform: PlatformName | "custom", host: string): string {
  const known = platform !== "custom" ? platforms[platform] : undefined;
  if (known && "socketUrl" in known) return known.socketUrl;
  const url = new URL(normalizeHost(host));
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const hostname = url.hostname.replace(/^(www\.)?/, "socket.");
  return `${scheme}//${hostname}/socket.io/?EIO=4&transport=websocket`;
}

export function texleafHome(): string {
  return path.join(os.homedir(), ".texleaf");
}

export function globalSessionFile(platform: PlatformName, profile = "default"): string {
  const safeProfile = safeFilePart(profile || "default");
  const filename = safeProfile === "default" ? `${platform}.json` : `${platform}-${safeProfile}.json`;
  return path.join(texleafHome(), "sessions", filename);
}

export function safeFilePart(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!safe) throw new ConfigError("Profile name must contain a safe filename character.");
  return safe;
}

export interface ProjectLocator {
  projectId: string;
  versionNo?: string;
  host?: string;
  platform?: PlatformName | "custom";
}

export function parseProjectLocator(value: string): ProjectLocator {
  const trimmed = value.trim();
  if (!trimmed) throw new ConfigError("Overleaf project id or URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return { projectId: trimmed };
  }
  if (hostPlatform(url.origin) === "texpage") {
    const userProject = url.pathname.match(/^\/project\/user\/([^/]+)\/([^/?#]+)/);
    const texpageMatch = userProject?.[1] ?? url.pathname.match(/^\/(?:project|editor)\/([^/?#]+)/)?.[1];
    if (texpageMatch) {
      const host = normalizeHost(url.origin);
      return {
        projectId: decodeURIComponent(texpageMatch),
        versionNo: userProject ? decodeURIComponent(userProject[2]) : undefined,
        host,
        platform: "texpage"
      };
    }
  }
  const match = url.pathname.match(/^\/(?:project|editor)\/([^/?#/]+)/);
  if (!match) return { projectId: trimmed };
  const host = normalizeHost(url.origin);
  return {
    projectId: decodeURIComponent(match[1]),
    host,
    platform: hostPlatform(host)
  };
}

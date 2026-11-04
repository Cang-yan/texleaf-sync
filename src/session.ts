import { type AuthSession, type AuthStatus, checkSession, loadSession, saveSession } from "./auth.js";
import { loginWithChrome } from "./chrome.js";
import { AuthError, ConfigError } from "./errors.js";
import { info } from "./log.js";
import { hostPlatform, normalizeHost, platformDisablesTls } from "./platform.js";

interface SessionOptions {
  host: string;
  profile: string;
  sessionFile: string;
  sslVerify?: boolean;
  timeoutMs?: number;
}

interface SessionServices {
  platform: NodeJS.Platform;
  loginWithChrome: typeof loginWithChrome;
  info: typeof info;
}

// Every remote command uses the same preflight: reuse a valid session, then try
// one browser import before asking the user to log in. Never replay a push.
export async function ensureSession(
  options: SessionOptions,
  services: SessionServices = { platform: process.platform, loginWithChrome, info }
): Promise<{ session: AuthSession; status: AuthStatus }> {
  const host = normalizeHost(options.host);
  let session: AuthSession | undefined;
  try {
    session = await loadSession(options.sessionFile, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof AuthError) throw error;
      // JSON parse errors can include parts of the saved cookies.
      throw new ConfigError(`Could not read session ${options.sessionFile}. Check its format and file permissions.`);
    }
  }
  const sslVerify =
    options.sslVerify ?? (session ? session.sslVerify !== false : !platformDisablesTls(hostPlatform(host), host));
  let reason = "No saved session";
  if (session) {
    session = { ...session, sslVerify };
    const status = await checkSession({ host, session, timeoutMs: options.timeoutMs });
    if (status.loggedIn) return { session, status };
    // A timeout, TLS error or server outage is not evidence of expired cookies.
    if (!status.authRequired) {
      throw new AuthError(`Could not validate session for ${host}: ${status.error ?? "unknown error"}. Retry later.`);
    }
    reason = "Saved session is no longer logged in";
  }

  const loginCommand = [
    "texleaf auth login --host",
    shellQuote(host),
    "--profile",
    shellQuote(options.profile),
    "--session-file",
    shellQuote(options.sessionFile),
    ...(sslVerify ? [] : ["--insecure"])
  ].join(" ");
  if (services.platform !== "darwin") {
    throw new AuthError(
      `${reason} for ${host}. Automatic Chrome cookie import supports macOS only.\nPlease log in: ${loginCommand}`
    );
  }

  services.info(`${reason} for ${host}; automatically checking Chrome session cookies...`);
  let imported: Awaited<ReturnType<typeof loginWithChrome>>;
  try {
    imported = await services.loginWithChrome({
      host,
      profile: options.profile,
      chromeProfile: session?.chromeProfile,
      sslVerify,
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    const detail = error instanceof AuthError ? error.message : "Could not read or validate Chrome cookies.";
    throw new AuthError(
      `Automatic session refresh failed for ${host}: ${detail}\nLog in to this site in Chrome and retry, or enter cookies manually: ${loginCommand}`
    );
  }
  // The importer validates the cookies before returning. Keep the old file if
  // discovery or validation fails, and preserve the configured session target.
  try {
    await saveSession(options.sessionFile, imported.session);
  } catch {
    throw new AuthError(
      `Found a valid Chrome session for ${host}, but could not save ${options.sessionFile}. Check file permissions and retry.`
    );
  }
  services.info(`Refreshed session from Chrome profile ${JSON.stringify(imported.chromeProfile)}; continuing.`);
  return { session: imported.session, status: imported.status };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

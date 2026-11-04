import path from "node:path";

import { saveSession } from "./auth.js";
import { createChromeLogin } from "./chrome.js";
import { TexleafError } from "./errors.js";
import {
  type PlatformName,
  globalSessionFile,
  hostPlatform,
  normalizeHost,
  platformDisablesTls,
  platformHost,
  platforms
} from "./platform.js";

export interface AuthTarget {
  host: string;
  platform: PlatformName | "custom";
  sessionFile: string;
}

interface AuthMenuOptions {
  profile?: string;
  sessionFile?: string;
  fromChrome?: boolean;
  chromeProfile?: string;
  insecure?: boolean;
}

interface MenuIO {
  question: (prompt: string) => Promise<string>;
  write: (message: string) => void;
  interactive: boolean;
}

interface MenuServices {
  platform: NodeJS.Platform;
  createChromeLogin: typeof createChromeLogin;
  saveSession: typeof saveSession;
  sessionFile: typeof globalSessionFile;
}

// Returns a target only when the user chooses manual login. A completed Chrome
// import (or choosing Finish after a partial import) needs no further login.
export async function chooseAuthTarget(
  options: AuthMenuOptions,
  io: MenuIO,
  services: MenuServices = {
    platform: process.platform,
    createChromeLogin,
    saveSession,
    sessionFile: globalSessionFile
  }
): Promise<AuthTarget | undefined> {
  const knownPlatforms = Object.keys(platforms) as PlatformName[];
  const profile = options.profile ?? "default";
  const customChoice = String(knownPlatforms.length + 1);
  const chromeChoice = String(knownPlatforms.length + 2);
  let fromChrome = Boolean(options.fromChrome);

  while (true) {
    if (!fromChrome) {
      io.write("Choose project platform:");
      knownPlatforms.forEach((platform, index) => io.write(`  ${index + 1}. ${platform} (${platformHost(platform)})`));
      io.write(`  ${customChoice}. custom host`);
      if (services.platform === "darwin") {
        io.write(`  ${chromeChoice}. From Chrome (check all supported platforms; macOS)`);
      }
      const choice = (await io.question("Platform [1]: ")).trim() || "1";
      if (choice === customChoice) {
        const host = normalizeHost(await io.question("Project service host: "));
        return {
          host,
          platform: hostPlatform(host),
          sessionFile: options.sessionFile ?? path.resolve(".texleaf/session.json")
        };
      }
      const platform = knownPlatforms.find((_, index) => choice === String(index + 1));
      if (platform) {
        return {
          host: platformHost(platform),
          platform,
          sessionFile: options.sessionFile ?? services.sessionFile(platform, profile)
        };
      }
      if (choice !== chromeChoice || services.platform !== "darwin") {
        io.write("Choose one of the listed options.");
        continue;
      }
    }

    if (services.platform !== "darwin") {
      throw new TexleafError(
        "Chrome cookie import currently supports macOS only. Run `texleaf auth login` to enter cookies manually."
      );
    }
    if (options.sessionFile) {
      const message =
        "Importing all platforms needs separate session files. Omit --session-file, or use --platform <name> --from-chrome for one platform.";
      if (fromChrome) throw new TexleafError(message);
      io.write(message);
      continue;
    }
    fromChrome = false;
    io.write(
      "Checking Chrome cookies for all supported platforms; macOS may ask for Chrome Safe Storage Keychain access."
    );
    const importSession = services.createChromeLogin();
    const missing: PlatformName[] = [];
    for (const platform of knownPlatforms) {
      const host = platformHost(platform);
      io.write(`Checking ${platform} (${host})...`);
      let imported: Awaited<ReturnType<typeof importSession>>;
      try {
        imported = await importSession({
          host,
          profile,
          chromeProfile: options.chromeProfile,
          sslVerify: options.insecure ? false : !platformDisablesTls(platform, host)
        });
      } catch (error) {
        missing.push(platform);
        const reason = error instanceof TexleafError ? error.message : "Could not read or validate the Chrome session.";
        io.write(`${platform}: not imported. ${reason}`);
        continue;
      }
      const sessionFile = services.sessionFile(platform, profile);
      try {
        await services.saveSession(sessionFile, imported.session);
      } catch {
        missing.push(platform);
        io.write(
          `${platform}: valid Chrome session found, but could not save it to ${sessionFile}. Check file permissions and retry.`
        );
        continue;
      }
      io.write(
        `${platform}: imported Chrome profile ${JSON.stringify(imported.chromeProfile)}. Saved session to ${sessionFile}`
      );
    }

    if (!missing.length) {
      io.write("Saved valid Chrome sessions for all supported platforms.");
      return;
    }
    io.write(`Manual login needed for: ${missing.join(", ")}.`);
    if (!io.interactive) {
      throw new TexleafError(
        "Some Chrome sessions could not be imported. Run `texleaf auth login` in a terminal to enter cookies manually."
      );
    }
    if (missing.length === knownPlatforms.length) {
      io.write("No Chrome sessions were saved. Please enter cookies manually; returning to the login menu.");
      continue;
    }
    while (true) {
      io.write("  1. Enter cookies manually (return to login menu)");
      io.write("  2. Finish");
      const choice = (await io.question("Next [1]: ")).trim() || "1";
      if (choice === "1") break;
      if (choice === "2") return;
      io.write("Choose 1 or 2.");
    }
  }
}

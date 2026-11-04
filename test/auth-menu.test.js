import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSession, saveSession, sessionFromCookieHeader } from "../dist/auth.js";
import { chooseAuthTarget } from "../dist/auth-menu.js";
import { AuthError } from "../dist/errors.js";
import { hostPlatform } from "../dist/platform.js";

async function menuFixture(t, answers, validPlatforms) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-auth-menu-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lines = [];
  const prompts = [];
  const imports = [];
  const queued = [...answers];
  const io = {
    interactive: true,
    write: (message) => lines.push(message),
    question: async (prompt) => {
      prompts.push(prompt);
      assert.ok(queued.length, `Unexpected prompt: ${prompt}`);
      return queued.shift();
    }
  };
  const services = {
    platform: "darwin",
    saveSession,
    sessionFile: (platform, profile = "default") => path.join(directory, `${platform}-${profile}.json`),
    createChromeLogin: () => async (args) => {
      const platform = hostPlatform(args.host);
      imports.push({ platform, ...args });
      if (!validPlatforms.includes(platform)) throw new AuthError("No valid Chrome cookies found.");
      return {
        chromeProfile: "Default",
        session: sessionFromCookieHeader({ ...args, cookieHeader: `session=${platform}-test-secret` })
      };
    }
  };
  return { directory, lines, prompts, imports, io, services };
}

test("From Chrome saves every valid platform and finishes without another prompt", async (t) => {
  const fixture = await menuFixture(t, ["5"], ["cstcloud", "overleaf", "texpage"]);
  const { io, services, imports, prompts, lines } = fixture;
  const target = await chooseAuthTarget({ profile: "research" }, io, services);
  assert.equal(target, undefined);
  assert.deepEqual(prompts, ["Platform [1]: "]);
  assert.deepEqual(
    imports.map(({ platform, sslVerify }) => [platform, sslVerify]),
    [
      ["cstcloud", false],
      ["overleaf", true],
      ["texpage", true]
    ]
  );
  for (const platform of ["cstcloud", "overleaf", "texpage"]) {
    const file = services.sessionFile(platform, "research");
    const session = await loadSession(file);
    assert.equal(session.profile, "research");
    assert.equal(session.cookies[0].value, `${platform}-test-secret`);
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  assert.match(lines.join("\n"), /From Chrome.*all supported platforms/);
  assert.match(lines.at(-1), /Saved valid Chrome sessions for all supported platforms/);
  assert.doesNotMatch(lines.join("\n"), /test-secret/);
});

test("when neither platform has valid cookies it explains why and returns to the login menu", async (t) => {
  const { io, services, lines, imports, prompts, directory } = await menuFixture(t, ["5", "2"], []);
  const target = await chooseAuthTarget({}, io, services);
  assert.equal(target.platform, "overleaf");
  assert.equal(imports.length, 3);
  assert.equal(lines.filter((line) => line === "Choose project platform:").length, 2);
  assert.match(lines.join("\n"), /Manual login needed for: cstcloud, overleaf, texpage/);
  assert.match(lines.join("\n"), /Please enter cookies manually; returning to the login menu/);
  assert.deepEqual(prompts, ["Platform [1]: ", "Platform [1]: "]);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("partial imports save valid cookies and the manual option returns to platform selection", async (t) => {
  const { io, services, lines, prompts } = await menuFixture(t, ["5", "1", "2"], ["cstcloud"]);
  // An expired/missing browser cookie must not erase an existing CLI session.
  const previousFile = services.sessionFile("overleaf");
  const previous = '{"saved":"keep-this-session"}\n';
  await fs.writeFile(previousFile, previous);
  const target = await chooseAuthTarget({}, io, services);
  assert.equal(target.platform, "overleaf");
  assert.equal((await loadSession(services.sessionFile("cstcloud"))).cookies[0].value, "cstcloud-test-secret");
  assert.equal(await fs.readFile(previousFile, "utf8"), previous);
  assert.match(lines.join("\n"), /Manual login needed for: overleaf/);
  assert.match(lines.join("\n"), /1\. Enter cookies manually \(return to login menu\)/);
  assert.deepEqual(prompts, ["Platform [1]: ", "Next [1]: ", "Platform [1]: "]);
});

test("a failed first platform does not stop importing the next; Finish keeps the saved session", async (t) => {
  const { io, services, lines, prompts, imports } = await menuFixture(t, ["5", "2"], ["overleaf"]);
  const target = await chooseAuthTarget({}, io, services);
  assert.equal(target, undefined);
  assert.deepEqual(
    imports.map(({ platform }) => platform),
    ["cstcloud", "overleaf", "texpage"]
  );
  assert.equal((await loadSession(services.sessionFile("overleaf"))).cookies[0].value, "overleaf-test-secret");
  assert.match(lines.join("\n"), /Manual login needed for: cstcloud/);
  assert.deepEqual(prompts, ["Platform [1]: ", "Next [1]: "]);
});

test("a save failure is reported as a failure and does not prevent saving another platform", async (t) => {
  const { io, services, lines } = await menuFixture(t, ["5", "2"], ["cstcloud", "overleaf", "texpage"]);
  services.saveSession = async (file, session) => {
    if (file === services.sessionFile("cstcloud")) throw new Error("EACCES");
    await saveSession(file, session);
  };
  await chooseAuthTarget({}, io, services);
  assert.match(lines.join("\n"), /cstcloud: valid Chrome session found, but could not save/);
  assert.doesNotMatch(lines.join("\n"), /Saved valid Chrome sessions for all supported platforms/);
  assert.equal((await loadSession(services.sessionFile("overleaf"))).cookies[0].value, "overleaf-test-secret");
});

test("Chrome import is absent from non-Mac menus and explicit use is rejected without reading cookies", async (t) => {
  for (const platform of ["win32", "linux"]) {
    const { io, services, lines, imports } = await menuFixture(t, ["1"], ["cstcloud"]);
    services.platform = platform;
    assert.equal((await chooseAuthTarget({}, io, services)).platform, "cstcloud");
    assert.doesNotMatch(lines.join("\n"), /From Chrome/);
    await assert.rejects(chooseAuthTarget({ fromChrome: true }, io, services), /macOS only/);
    assert.deepEqual(imports, []);
  }
});

test("a single --session-file cannot be overwritten by a multi-platform import", async (t) => {
  const { io, services, lines, imports } = await menuFixture(t, ["5", "2"], ["cstcloud", "overleaf", "texpage"]);
  const options = { sessionFile: path.join(services.sessionFile("overleaf"), "custom.json") };
  const target = await chooseAuthTarget(options, io, services);
  assert.equal(target.sessionFile, options.sessionFile);
  assert.match(lines.join("\n"), /Importing all platforms needs separate session files/);
  assert.deepEqual(imports, []);
  await assert.rejects(chooseAuthTarget({ ...options, fromChrome: true }, io, services), /separate session files/);
});

test("--from-chrome checks all platforms directly and noninteractive failures do not prompt", async (t) => {
  const { io, services, lines, prompts } = await menuFixture(t, [], ["cstcloud"]);
  io.interactive = false;
  await assert.rejects(
    chooseAuthTarget({ fromChrome: true, chromeProfile: "Default" }, io, services),
    /in a terminal to enter cookies manually/
  );
  assert.equal((await loadSession(services.sessionFile("cstcloud"))).cookies[0].value, "cstcloud-test-secret");
  assert.deepEqual(prompts, []);
  assert.doesNotMatch(lines.join("\n"), /Choose project platform/);
});

test("manual choices and invalid input never start a Chrome scan", async (t) => {
  const { io, services, imports, lines } = await menuFixture(t, ["invalid", "4", "https://overleaf.example.test"], []);
  const target = await chooseAuthTarget({}, io, services);
  assert.equal(target.platform, "custom");
  assert.equal(target.host, "https://overleaf.example.test");
  assert.match(lines.join("\n"), /Choose one of the listed options/);
  assert.deepEqual(imports, []);
});

test("TexPage is available as a direct platform choice", async (t) => {
  const { io, services } = await menuFixture(t, ["3"], []);
  const target = await chooseAuthTarget({}, io, services);
  assert.equal(target.platform, "texpage");
  assert.equal(target.host, "https://www.texpage.com");
});

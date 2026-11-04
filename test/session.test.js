import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { cookieHeader, loadSession, saveSession, sessionFromCookieHeader } from "../dist/auth.js";
import { OverleafBackend } from "../dist/backend.js";
import { createChromeLogin } from "../dist/chrome.js";
import { defaultConfig } from "../dist/config.js";
import { AuthError } from "../dist/errors.js";
import { ensureSession } from "../dist/session.js";
import { SyncEngine } from "../dist/sync.js";
import { TexPageBackend } from "../dist/texpage-backend.js";

async function fixture(t, platform = "overleaf") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-session-refresh-"));
  // Initialize Node's lazy fetch globals before installing the test dispatcher.
  void globalThis.Headers;
  const agent = new MockAgent();
  agent.disableNetConnect();
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const host = platform === "texpage" ? "https://www.texpage.com" : "https://www.overleaf.com";
  const name = platform === "texpage" ? "SESSIONID" : "overleaf_session2";
  const options = {
    host,
    profile: "research",
    sessionFile: path.join(directory, ".texleaf", "session.json"),
    sslVerify: true,
    timeoutMs: 1_000
  };
  const session = sessionFromCookieHeader({ ...options, cookieHeader: `${name}=saved-secret` });
  await saveSession(options.sessionFile, session);
  const original = await fs.readFile(options.sessionFile, "utf8");
  const chromeDir = path.join(directory, "Chrome");
  const profiles = { Default: "fresh-secret" };
  async function addProfile(profile, value) {
    profiles[profile] = value;
    await fs.mkdir(path.join(chromeDir, profile, "Network"), { recursive: true });
    await fs.writeFile(path.join(chromeDir, profile, "Network", "Cookies"), "fixture");
  }
  await addProfile("Default", "fresh-secret");
  const importer = createChromeLogin({
    platform: "darwin",
    userDataDir: chromeDir,
    readCookies: async (database, url) => {
      assert.equal(url.origin, host);
      const value = profiles[path.basename(path.dirname(path.dirname(database)))];
      return value
        ? [{ host_key: url.hostname, name, value, encrypted_value: "", path: "/", is_secure: 1, version: 24 }]
        : [];
    },
    readPassword: () => assert.fail("plaintext fixtures must not access the real Keychain")
  });
  const calls = [];
  const lines = [];
  const services = {
    platform: "darwin",
    loginWithChrome: async (args) => {
      calls.push(args);
      return await importer(args);
    },
    info: (line) => lines.push(line)
  };
  const pool = agent.get(host);
  function check(value, httpStatus = 200, data) {
    return pool
      .intercept({
        method: "GET",
        path: platform === "texpage" ? /^\/api\/project\/total\?t=\d+$/ : "/user/personal_info",
        headers: { cookie: `${name}=${value}` }
      })
      .reply(
        httpStatus,
        data ?? (platform === "texpage" ? { status: { code: 1 } } : { email: "user@example.invalid", _id: "user-id" })
      );
  }
  return {
    directory,
    agent,
    pool,
    options,
    session,
    original,
    chromeDir,
    profiles,
    addProfile,
    services,
    calls,
    lines,
    check
  };
}

test("a valid saved session continues without reading Chrome or rewriting the file", async (t) => {
  const f = await fixture(t);
  f.check("saved-secret");
  const { session, status } = await ensureSession(f.options, f.services);
  assert.equal(cookieHeader(session), "overleaf_session2=saved-secret");
  assert.equal(status.email, "user@example.invalid");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.lines, []);
  assert.equal(await fs.readFile(f.options.sessionFile, "utf8"), f.original);
  f.agent.assertNoPendingInterceptors();
});

for (const [platform, Backend] of [
  ["overleaf", OverleafBackend],
  ["texpage", TexPageBackend]
]) {
  test(`${platform} automatically recovers an expired session and uses it for the requested operation`, async (t) => {
    const f = await fixture(t, platform);
    if (platform === "texpage") f.check("saved-secret", 200, { status: { code: 0 } });
    else f.check("saved-secret", 302);
    f.check("fresh-secret");
    const config = defaultConfig({
      ...f.options,
      repoRoot: f.directory,
      projectId: "project-id",
      projectName: "Paper",
      sessionFile: ".texleaf/session.json"
    });
    config.backend.timeoutMs = 1_000;
    assert.equal(config.backend.sslVerify, true);
    const backend = new Backend(f.directory, config, (args) => ensureSession(args, f.services));
    await backend.authenticate();
    f.pool
      .intercept({
        method: "GET",
        path: platform === "texpage" ? /^\/api\/project\?/ : "/project/project-id",
        headers: { cookie: platform === "texpage" ? "SESSIONID=fresh-secret" : "overleaf_session2=fresh-secret" }
      })
      .reply(
        200,
        platform === "texpage"
          ? {
              status: { code: 1 },
              result: {
                list: [
                  {
                    projectKey: "project-id",
                    ownerKey: "owner",
                    projectName: "Paper",
                    selectedVersion: { versionNo: "v1" }
                  }
                ]
              }
            }
          : "<title>Paper - Overleaf, Online LaTeX Editor</title>"
      );
    assert.equal(getGlobalDispatcher(), f.agent);
    assert.equal(await backend.projectName("project-id"), "Paper");
    const saved = await loadSession(f.options.sessionFile);
    assert.equal(saved.cookies[0].value, "fresh-secret");
    assert.equal(saved.profile, "research");
    assert.equal(saved.chromeProfile, path.join(f.chromeDir, "Default"));
    assert.equal((await fs.stat(f.options.sessionFile)).mode & 0o777, 0o600);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].timeoutMs, config.backend.timeoutMs);
    assert.equal(f.calls[0].sslVerify, config.backend.sslVerify);
    assert.match(f.lines.at(-1), /Refreshed session.*continuing/);
    assert.doesNotMatch(f.lines.join("\n"), /saved-secret|fresh-secret|texleaf auth login/);
    f.check("fresh-secret");
    await backend.authenticate();
    assert.equal(f.calls.length, 1);
    f.agent.assertNoPendingInterceptors();
  });
}

for (const httpStatus of [401, 403]) {
  test(`HTTP ${httpStatus} during session validation triggers recovery`, async (t) => {
    const f = await fixture(t);
    f.check("saved-secret", httpStatus);
    f.check("fresh-secret");
    await ensureSession(f.options, f.services);
    assert.equal(f.calls.length, 1);
    f.agent.assertNoPendingInterceptors();
  });
}

test("a missing session is imported before requesting manual login", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.options.sessionFile);
  f.check("fresh-secret");
  await ensureSession(f.options, f.services);
  assert.equal((await loadSession(f.options.sessionFile)).cookies[0].value, "fresh-secret");
  assert.equal(f.calls.length, 1);
  f.agent.assertNoPendingInterceptors();
});

test("refresh reuses the saved Chrome directory when several profiles contain cookies", async (t) => {
  const f = await fixture(t);
  await f.addProfile("Profile 1", "chosen-secret");
  const chromeProfile = path.join(f.chromeDir, "Profile 1");
  await saveSession(f.options.sessionFile, { ...f.session, chromeProfile });
  f.check("saved-secret", 302);
  f.check("chosen-secret");
  const { session } = await ensureSession(f.options, f.services);
  assert.equal(session.cookies[0].value, "chosen-secret");
  assert.equal(f.calls[0].chromeProfile, chromeProfile);
  assert.equal((await loadSession(f.options.sessionFile)).chromeProfile, chromeProfile);
  f.agent.assertNoPendingInterceptors();
});

for (const failure of ["missing", "expired", "ambiguous", "unexpected"]) {
  test(`a ${failure} browser session is tried once before giving login guidance and preserving the old file`, async (t) => {
    const f = await fixture(t);
    f.check("saved-secret", 302);
    if (failure === "missing") f.profiles.Default = "";
    if (failure === "expired") f.check("fresh-secret", 401);
    if (failure === "ambiguous") await f.addProfile("Profile 1", "other-secret");
    if (failure === "unexpected") {
      f.services.loginWithChrome = async (args) => {
        f.calls.push(args);
        throw new Error("unexpected-cookie-secret");
      };
    }
    await assert.rejects(ensureSession(f.options, f.services), (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /Automatic session refresh failed/);
      assert.ok(
        error.message.includes(
          `texleaf auth login --host '${f.options.host}' --profile 'research' --session-file '${f.options.sessionFile}'`
        )
      );
      assert.doesNotMatch(error.message, /saved-secret|fresh-secret|other-secret|unexpected-cookie-secret/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(await fs.readFile(f.options.sessionFile, "utf8"), f.original);
    assert.doesNotMatch(f.lines.join("\n"), /texleaf auth login|Refreshed session/);
    f.agent.assertNoPendingInterceptors();
  });
}

for (const failure of [429, 503, "network", "invalid-json"]) {
  test(`${failure} validation failures do not read Chrome or ask for a new login`, async (t) => {
    const f = await fixture(t);
    if (failure === "network") {
      f.pool.intercept({ method: "GET", path: "/user/personal_info" }).replyWithError(new Error("offline"));
    } else if (failure === "invalid-json") f.check("saved-secret", 200, "not JSON");
    else f.check("saved-secret", failure);
    await assert.rejects(ensureSession(f.options, f.services), (error) => {
      assert.match(error.message, /Could not validate session/);
      assert.doesNotMatch(error.message, /texleaf auth login|Chrome/);
      return true;
    });
    assert.equal(f.calls.length, 0);
    assert.equal(await fs.readFile(f.options.sessionFile, "utf8"), f.original);
    f.agent.assertNoPendingInterceptors();
  });
}

test("unsupported systems provide targeted manual login guidance without reading Chrome", async (t) => {
  const f = await fixture(t);
  f.services.platform = "linux";
  f.check("saved-secret", 302);
  await assert.rejects(ensureSession(f.options, f.services), /macOS only.*\nPlease log in: texleaf auth login/);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(f.options.sessionFile, "utf8"), f.original);
  f.agent.assertNoPendingInterceptors();
});

test("invalid session files and host mismatches are preserved without trying a different account", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.options.sessionFile, "broken-cookie-secret");
  await assert.rejects(ensureSession(f.options, f.services), (error) => {
    assert.match(error.message, /Could not read session/);
    assert.doesNotMatch(error.message, /broken-cookie-secret/);
    return true;
  });
  assert.equal(await fs.readFile(f.options.sessionFile, "utf8"), "broken-cookie-secret");
  await saveSession(f.options.sessionFile, { ...f.session, host: "https://different.example.invalid" });
  await assert.rejects(ensureSession(f.options, f.services), /does not match/);
  assert.equal(f.calls.length, 0);
});

test("missing legacy TLS settings default to verification and explicit configuration reaches the importer", async (t) => {
  const f = await fixture(t);
  const legacy = { ...f.session };
  delete legacy.sslVerify;
  await saveSession(f.options.sessionFile, legacy);
  f.check("saved-secret", 302);
  f.check("fresh-secret");
  await ensureSession({ ...f.options, sslVerify: undefined }, f.services);
  assert.equal(f.calls[0].sslVerify, true);
  await fs.rm(f.options.sessionFile);
  f.services.loginWithChrome = async (args) => {
    assert.equal(args.sslVerify, false);
    return { session: { ...f.session, sslVerify: false }, status: { loggedIn: true }, chromeProfile: "Default" };
  };
  await ensureSession({ ...f.options, sslVerify: false }, f.services);
  assert.equal((await loadSession(f.options.sessionFile)).sslVerify, false);
  f.agent.assertNoPendingInterceptors();
});

test("push resumes after automatic session recovery and does not repeat the write on the next push", async (t) => {
  const f = await fixture(t);
  let remoteText = "original paper\n";
  let writes = 0;
  const factory = (repoRoot, config) => {
    const backend = new OverleafBackend(repoRoot, config, (args) => ensureSession(args, f.services));
    backend.downloadSnapshot = async (_projectId, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, "paper.tex"), remoteText);
    };
    backend.writeTextFile = async (_projectId, projectPath, text) => {
      assert.equal(projectPath, "paper.tex");
      assert.equal(cookieHeader(backend.requireSession()), "overleaf_session2=fresh-secret");
      writes++;
      remoteText = text;
    };
    return backend;
  };
  f.check("saved-secret").times(2);
  const repo = await new SyncEngine(f.directory, factory).clone({
    ...f.options,
    projectId: "project-id",
    projectName: "Paper",
    directory: "paper"
  });
  await fs.writeFile(path.join(repo, "paper.tex"), "updated paper\n");
  execFileSync("git", ["add", "paper.tex"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Update paper"],
    { cwd: repo }
  );
  f.check("saved-secret", 302);
  f.check("fresh-secret");
  const engine = new SyncEngine(repo, factory);
  await engine.push();
  assert.equal(remoteText, "updated paper\n");
  assert.equal(writes, 1);
  assert.equal(f.calls.length, 1);
  await assert.rejects(fs.stat(path.join(repo, ".texleaf", "lock")), { code: "ENOENT" });
  f.check("fresh-secret");
  await engine.push();
  assert.equal(writes, 1);
  assert.equal(f.calls.length, 1);
  f.agent.assertNoPendingInterceptors();
});

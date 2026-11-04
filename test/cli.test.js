import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSession, saveSession, sessionFromCookieHeader } from "../dist/auth.js";

test("clone help uses positional project locator", () => {
  const output = execFileSync(process.execPath, ["dist/cli.js", "clone", "--help"], { encoding: "utf8" });
  assert.match(output, /Usage: texleaf clone \[options\] <project> \[directory\]/);
  assert.match(output, /project id or project URL/);
  assert.doesNotMatch(output, /--project-id/);
});

test("Chrome login options reject conflicting inputs before any credential access", () => {
  for (const [options, message] of [
    [["--chrome-profile", "Default"], /Use --chrome-profile only with --from-chrome/],
    [["--from-chrome", "--email", "test@example.com"], /Use --from-chrome separately/],
    [["--from-chrome", "--password-stdin"], /Use --from-chrome separately/]
  ]) {
    const result = spawnSync(process.execPath, ["dist/cli.js", "auth", "login", ...options], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("TexPage password login is rejected before prompting or reading credentials", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/cli.js", "auth", "login", "--platform", "texpage", "--email", "person@example.invalid", "--password-stdin"],
    { encoding: "utf8", input: "" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TexPage uses Cookie sessions/);
  assert.doesNotMatch(result.stderr, /standard input|No password/);
});

test("failed Chrome imports preserve an existing saved session", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.json");
  const original = '{"saved":"keep-existing-session"}\n';
  await fs.writeFile(sessionFile, original, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      "dist/cli.js",
      "auth",
      "login",
      "--platform",
      "cstcloud",
      "--from-chrome",
      "--chrome-profile",
      path.join(directory, "missing-profile"),
      "--session-file",
      sessionFile
    ],
    { encoding: "utf8", timeout: 5_000 }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No saved Chrome session cookies|macOS only/);
  assert.equal(await fs.readFile(sessionFile, "utf8"), original);
});

test(
  "--from-chrome without a target checks every supported platform",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-batch-cli-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "auth", "login", "--from-chrome", "--chrome-profile", directory],
      { encoding: "utf8", timeout: 5_000 }
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Checking cstcloud/);
    assert.match(result.stdout, /Checking overleaf/);
    assert.match(result.stdout, /Manual login needed for: cstcloud, overleaf/);
    assert.match(result.stderr, /in a terminal to enter cookies manually/);
    assert.doesNotMatch(result.stdout, /Platform \[1\]/);
  }
);

for (const hasCookies of [true, false]) {
  test(
    `auth status ${hasCookies ? "refreshes from Chrome and continues" : "searches Chrome before giving login guidance"} without a terminal`,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-auto-auth-cli-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const seen = [];
      const server = http.createServer((request, response) => {
        seen.push(request.headers.cookie);
        if (request.headers.cookie === "sharelatex.sid=browser-test-secret") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ email: "user@example.invalid", _id: "test-user" }));
        } else {
          response.writeHead(302, { location: "/login" });
          response.end();
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const host = `http://127.0.0.1:${server.address().port}`;
      const chromeProfile = path.join(directory, "Selected Chrome Profile");
      await fs.mkdir(path.join(chromeProfile, "Network"), { recursive: true });
      // Only a temporary plaintext database is used, so no real browser cookies
      // or Keychain entries are accessed by the CLI process.
      execFileSync("/usr/bin/sqlite3", [
        "-init",
        "/dev/null",
        path.join(chromeProfile, "Network", "Cookies"),
        `CREATE TABLE meta (key TEXT, value TEXT);
         INSERT INTO meta VALUES ('version', '24');
         CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
           path TEXT, is_secure INTEGER, has_expires INTEGER, expires_utc INTEGER, creation_utc INTEGER);
         ${hasCookies ? "INSERT INTO cookies VALUES ('127.0.0.1', 'sharelatex.sid', 'browser-test-secret', X'', '/', 0, 0, 0, 0);" : ""}`
      ]);
      const sessionFile = path.join(directory, "custom-session.json");
      await saveSession(sessionFile, {
        ...sessionFromCookieHeader({
          host,
          profile: "research",
          cookieHeader: "sharelatex.sid=old-test-secret",
          sslVerify: true
        }),
        chromeProfile
      });
      const original = await fs.readFile(sessionFile, "utf8");
      // A project can point to a non-default profile and a relative session
      // file. Automatic refresh must follow those settings when no flags are set.
      await fs.mkdir(path.join(directory, ".texleaf"));
      await fs.writeFile(
        path.join(directory, ".texleaf", "config.json"),
        JSON.stringify({
          project: { host, projectId: "test-project", platform: "custom" },
          auth: { profile: "research", sessionFile: "custom-session.json" }
        })
      );
      const run = promisify(execFile)(
        process.execPath,
        [
          path.resolve("dist/cli.js"),
          "auth",
          "status",
          ...(hasCookies ? [] : ["--host", host, "--profile", "research", "--session-file", sessionFile])
        ],
        { timeout: 5_000, cwd: directory }
      );
      if (hasCookies) {
        const result = await run;
        assert.match(result.stdout, /Logged in.*user@example.invalid/);
        assert.match(result.stderr, /automatically checking Chrome.*\n.*Refreshed session/);
        assert.doesNotMatch(result.stderr, /Please log in|old-test-secret|browser-test-secret/);
        assert.equal((await loadSession(sessionFile)).cookies[0].value, "browser-test-secret");
        assert.equal((await loadSession(sessionFile)).profile, "research");
        await assert.rejects(fs.stat(path.join(directory, ".texleaf", "session.json")), { code: "ENOENT" });
        assert.deepEqual(seen, ["sharelatex.sid=old-test-secret", "sharelatex.sid=browser-test-secret"]);
      } else {
        await assert.rejects(run, (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /automatically checking Chrome.*\nAutomatic session refresh failed/);
          assert.match(error.stderr, /No saved Chrome session cookies/);
          assert.ok(error.stderr.includes(`--session-file '${sessionFile}'`));
          assert.doesNotMatch(error.stderr, /old-test-secret|browser-test-secret/);
          return true;
        });
        assert.equal(await fs.readFile(sessionFile, "utf8"), original);
        assert.deepEqual(seen, ["sharelatex.sid=old-test-secret"]);
      }
    }
  );
}

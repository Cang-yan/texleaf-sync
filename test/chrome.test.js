import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { cookieHeader } from "../dist/auth.js";
import { createChromeLogin, loginWithChrome, readChromeCookieRows } from "../dist/chrome.js";

const host = "https://latex.cstcloud.cn";
const password = "test-only-chrome-key";
const loginArgs = { host, profile: "research", sslVerify: true, timeoutMs: 1_000 };

function cookieRow(name, value, options = {}) {
  const row = {
    host_key: "latex.cstcloud.cn", name, value: "", path: "/", is_secure: 1,
    version: 24, ...options
  };
  const clear = row.version >= 24
    ? Buffer.concat([createHash("sha256").update(row.host_key).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 0x20));
  row.encrypted_value = Buffer.concat([Buffer.from("v10"), cipher.update(clear), cipher.final()]).toString("hex");
  return row;
}

async function fixture(t, profiles) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-"));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  for (const name of Object.keys(profiles)) {
    const directory = path.join(userDataDir, name, "Network");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "Cookies"), "fixture");
  }
  let keychainReads = 0;
  const access = {
    platform: "darwin", userDataDir,
    readCookies: async (database, url, names) => {
      assert.equal(url.origin, host);
      assert.deepEqual(names, ["latex-session", "overleaf.sid"]);
      return profiles[path.basename(path.dirname(path.dirname(database)))];
    },
    readPassword: async () => { keychainReads++; return password; }
  };
  return { access, keychainReads: () => keychainReads };
}

function mockSessionCheck(t, expectedCookie, statusCode = 200) {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get(host).intercept({
    method: "GET", path: "/user/personal_info", headers: { cookie: expectedCookie }
  }).reply(statusCode, { email: "test@example.com", _id: "test-user" });
  t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
  return agent;
}

test("imports and verifies one Chrome profile using version 24 encrypted cookies", async (t) => {
  const rows = [cookieRow("latex-session", "session=with=equals"), cookieRow("overleaf.sid", "sid-value", { host_key: ".cstcloud.cn" })];
  const { access, keychainReads } = await fixture(t, { Default: [], "Profile 1": rows });
  const expected = "latex-session=session=with=equals; overleaf.sid=sid-value";
  const agent = mockSessionCheck(t, expected);
  const imported = await loginWithChrome(loginArgs, access);
  assert.equal(imported.chromeProfile, "Profile 1");
  assert.equal(imported.session.profile, "research");
  assert.equal(imported.session.host, host);
  assert.equal(cookieHeader(imported.session), expected);
  assert.equal(imported.session.cookies[1].domain, ".cstcloud.cn");
  assert.equal(keychainReads(), 1);
  agent.assertNoPendingInterceptors();
});

test("a multi-platform scan requests the Chrome Keychain password only once", async (t) => {
  const { access, keychainReads } = await fixture(t, { Default: [] });
  access.readCookies = async (_database, url) => url.origin === host
    ? [cookieRow("latex-session", "cstcloud-session")]
    : [cookieRow("overleaf_session2", "overleaf-session", { host_key: ".overleaf.com" })];
  const agent = mockSessionCheck(t, "latex-session=cstcloud-session");
  agent.get("https://www.overleaf.com").intercept({
    method: "GET", path: "/user/personal_info", headers: { cookie: "overleaf_session2=overleaf-session" }
  }).reply(200, { email: "test@example.com", _id: "overleaf-user" });
  const importSession = createChromeLogin(access);
  await importSession(loginArgs);
  await importSession({ ...loginArgs, host: "https://www.overleaf.com" });
  assert.equal(keychainReads(), 1);
  agent.assertNoPendingInterceptors();
});

test("requires explicit selection before accessing Keychain when profiles overlap", async (t) => {
  const { access, keychainReads } = await fixture(t, {
    Default: [cookieRow("latex-session", "default-secret")],
    "Profile 1": [cookieRow("latex-session", "other-secret")]
  });
  await assert.rejects(loginWithChrome(loginArgs, access), (error) => {
    assert.match(error.message, /multiple Chrome profiles.*Default.*Profile 1.*--chrome-profile/);
    assert.doesNotMatch(error.message, /default-secret|other-secret/);
    return true;
  });
  assert.equal(keychainReads(), 0);
  const agent = mockSessionCheck(t, "latex-session=other-secret");
  const imported = await loginWithChrome({ ...loginArgs, chromeProfile: "Profile 1" }, access);
  assert.equal(imported.chromeProfile, "Profile 1");
  assert.equal(keychainReads(), 1);
  agent.assertNoPendingInterceptors();
});

test("imports legacy encrypted values and a profile given by absolute path", async (t) => {
  const { access } = await fixture(t, { Default: [cookieRow("latex-session", "legacy-value", { version: 23 })] });
  const agent = mockSessionCheck(t, "latex-session=legacy-value");
  const result = await loginWithChrome({ ...loginArgs, chromeProfile: path.join(access.userDataDir, "Default") }, access);
  assert.equal(result.session.cookies[0].value, "legacy-value");
  agent.assertNoPendingInterceptors();
});

test("does not request Keychain access for missing cookies or plaintext cookies", async (t) => {
  const { access, keychainReads } = await fixture(t, { Default: [] });
  await assert.rejects(loginWithChrome(loginArgs, access), /No saved Chrome session cookies/);
  assert.equal(keychainReads(), 0);
  access.readCookies = async () => [{ ...cookieRow("latex-session", "unused"), encrypted_value: "", value: "plaintext" }];
  const agent = mockSessionCheck(t, "latex-session=plaintext");
  await loginWithChrome(loginArgs, access);
  assert.equal(keychainReads(), 0);
  agent.assertNoPendingInterceptors();
});

test("rejects cookies encrypted for a different domain and unsupported formats", async (t) => {
  const row = cookieRow("latex-session", "never-print-this", { host_key: "other.example.com" });
  row.host_key = "latex.cstcloud.cn";
  const { access } = await fixture(t, { Default: [row] });
  await assert.rejects(loginWithChrome(loginArgs, access), /domain verification failed/);
  row.encrypted_value = `763230${row.encrypted_value.slice(6)}`;
  await assert.rejects(loginWithChrome(loginArgs, access), /Unsupported Chrome cookie encryption/);
  row.encrypted_value = "76313000";
  await assert.rejects(loginWithChrome(loginArgs, access), /Could not decrypt Chrome cookies/);
});

test("rejects expired server sessions before returning an import to save", async (t) => {
  const { access } = await fixture(t, { Default: [cookieRow("latex-session", "expired-session")] });
  const agent = mockSessionCheck(t, "latex-session=expired-session", 302);
  await assert.rejects(loginWithChrome(loginArgs, access), (error) => {
    assert.match(error.message, /Chrome session is not logged in/);
    assert.doesNotMatch(error.message, /expired-session/);
    return true;
  });
  agent.assertNoPendingInterceptors();
});

test("rejects unsupported operating systems without touching browser storage", async () => {
  for (const platform of ["linux", "win32"]) {
    await assert.rejects(loginWithChrome(loginArgs, {
      platform,
      readCookies: () => assert.fail("must not read cookies"),
      readPassword: () => assert.fail("must not access Keychain")
    }), /macOS only/);
  }
});

test("filters SQLite cookies by host, name, expiry, partition, scheme and path", { skip: process.platform !== "darwin" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-sqlite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "Cookies");
  const sql = (value) => typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
  const records = [
    ["latex.cstcloud.cn", "latex-session", "valid", "/", 1, 0, 0, ""],
    [".cstcloud.cn", "overleaf.sid", "parent-domain", "/", 0, 1, "99999999999999999", ""],
    ["cstcloud.cn", "latex-session", "parent-host-only", "/", 0, 0, 0, ""],
    ["evilcstcloud.cn", "latex-session", "wrong-domain", "/", 0, 0, 0, ""],
    ["latex.cstcloud.cn.evil.test", "latex-session", "wrong-suffix", "/", 0, 0, 0, ""],
    ["latex.cstcloud.cn", "analytics", "wrong-name", "/", 0, 0, 0, ""],
    ["latex.cstcloud.cn", "latex-session", "expired", "/", 0, 1, 1, ""],
    ["latex.cstcloud.cn", "latex-session", "partitioned", "/", 0, 0, 0, "https://other.test"],
    ["latex.cstcloud.cn", "latex-session", "project-only", "/project", 0, 0, 0, ""],
    ["latex.cstcloud.cn", "latex-session", "path-prefix-only", "/pro", 0, 0, 0, ""]
  ];
  execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", database], { input: `
    CREATE TABLE meta (key TEXT, value TEXT);
    INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, path TEXT, is_secure INTEGER,
      has_expires INTEGER, expires_utc INTEGER, top_frame_site_key TEXT,
      encrypted_value BLOB DEFAULT X'', creation_utc INTEGER DEFAULT 0);
    INSERT INTO cookies (host_key, name, value, path, is_secure, has_expires, expires_utc, top_frame_site_key)
      VALUES ${records.map((record) => `(${record.map(sql).join(",")})`).join(",")};
  ` });
  const before = await fs.readFile(database);
  const names = ["latex-session", "overleaf.sid"];
  const rows = await readChromeCookieRows(database, new URL(host), names);
  assert.deepEqual(rows.map((row) => row.value), ["valid", "parent-domain"]);
  assert.ok(rows.every((row) => row.version === 24));
  const insecureRows = await readChromeCookieRows(database, new URL("http://latex.cstcloud.cn"), names);
  assert.deepEqual(insecureRows.map((row) => row.value), ["parent-domain"]);
  const subpathRows = await readChromeCookieRows(database, new URL(`${host}/project/`), names);
  assert.deepEqual(subpathRows.map((row) => row.value), ["project-only", "valid", "parent-domain"]);
  const customRows = await readChromeCookieRows(database, new URL(host), []);
  assert.ok(customRows.some((row) => row.name === "analytics"));
  assert.deepEqual(await fs.readFile(database), before);
});

test("hides SQLite errors and captured data behind an actionable error", { skip: process.platform !== "darwin" }, async (t) => {
  const { access } = await fixture(t, { Default: [] });
  await assert.rejects(readChromeCookieRows(path.join(access.userDataDir, "Default", "Network", "Cookies"), new URL(host), []), (error) => {
    assert.match(error.message, /Could not read Chrome's cookie database/);
    assert.doesNotMatch(error.message, /Command failed|SELECT|fixture/);
    return true;
  });
});

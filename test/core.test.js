import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { cleanProjectTitle, textReplacementOperation } from "../dist/backend.js";
import { loadSession, loginWithPassword, saveSession, sessionFromCookieHeader } from "../dist/auth.js";
import { defaultConfig } from "../dist/config.js";
import { globalSessionFile, hostPlatform, parseProjectLocator } from "../dist/platform.js";
import { isIgnored, normalizeProjectPath } from "../dist/snapshot.js";

test("cleans Overleaf and cstcloud project titles", () => {
  assert.equal(cleanProjectTitle("Paper - Overleaf, Online LaTeX Editor"), "Paper");
  assert.equal(cleanProjectTitle("Paper - 中国科技云论文协同编辑服务, Online LaTeX Editor"), "Paper");
});

test("builds minimal text replacement operations", () => {
  assert.deepEqual(textReplacementOperation("prefix old suffix", "prefix new suffix"), [
    { d: "old", p: 7 },
    { i: "new", p: 7 }
  ]);
  assert.deepEqual(textReplacementOperation("same", "same"), []);
});

test("normalizes and rejects unsafe project paths", () => {
  assert.equal(normalizeProjectPath("sections\\intro.tex"), "sections/intro.tex");
  assert.throws(() => normalizeProjectPath("../secret.tex"));
  assert.throws(() => normalizeProjectPath("/secret.tex"));
});

test("matches sync ignore patterns", () => {
  assert.equal(isIgnored(".texleaf/config.json", [".texleaf/"]), true);
  assert.equal(isIgnored("main.tex", [".texleaf/"]), false);
  assert.equal(isIgnored("build/main.aux", ["*.aux"]), true);
});

test("creates known-platform config with global session", async () => {
  const previousHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-home-"));
  process.env.HOME = home;
  try {
    assert.equal(hostPlatform("https://latex.cstcloud.cn/"), "cstcloud");
    const sessionFile = globalSessionFile("cstcloud");
    const config = defaultConfig({
      repoRoot: "/repo",
      host: "https://latex.cstcloud.cn",
      projectId: "project123",
      projectName: "paper"
    });
    assert.equal(config.project.platform, "cstcloud");
    assert.equal(config.auth.sessionFile, sessionFile);
    assert.equal(config.backend.sslVerify, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("creates custom-host config with project-local session", () => {
  assert.equal(hostPlatform("http://localhost:8080/"), "custom");
  const config = defaultConfig({
    repoRoot: "/repo",
    host: "http://localhost:8080",
    projectId: "project123",
    projectName: "paper"
  });
  assert.equal(config.project.platform, "custom");
  assert.equal(config.project.host, "http://localhost:8080");
  assert.equal(config.auth.sessionFile, ".texleaf/session.json");
  assert.equal(config.backend.sslVerify, true);
});

test("parses Overleaf project URLs", () => {
  assert.deepEqual(parseProjectLocator("6a72a92ee92000863e4de8a1"), {
    projectId: "6a72a92ee92000863e4de8a1"
  });
  assert.deepEqual(parseProjectLocator("https://latex.cstcloud.cn/project/6a72a92ee92000863e4de8a1"), {
    projectId: "6a72a92ee92000863e4de8a1",
    host: "https://latex.cstcloud.cn",
    platform: "cstcloud"
  });
  assert.deepEqual(parseProjectLocator("https://www.overleaf.com/project/697aee96f59bdd00852659f7"), {
    projectId: "697aee96f59bdd00852659f7",
    host: "https://www.overleaf.com",
    platform: "overleaf"
  });
  assert.deepEqual(parseProjectLocator("https://cn.overleaf.com/project/697aee96f59bdd00852659f7"), {
    projectId: "697aee96f59bdd00852659f7",
    host: "https://cn.overleaf.com",
    platform: "overleaf"
  });
});

test("loads official Overleaf sessions across host aliases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-session-"));
  const file = path.join(dir, "session.json");
  await saveSession(
    file,
    sessionFromCookieHeader({
      host: "https://www.overleaf.com",
      profile: "default",
      cookieHeader: "overleaf_session2=abc",
      sslVerify: true
    })
  );
  const session = await loadSession(file, "https://cn.overleaf.com");
  assert.equal(session.host, "https://www.overleaf.com");
});

test("logs in to custom host with email and password", async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const origin = "http://overleaf.test";
  const pool = mockAgent.get(origin);
  pool
    .intercept({ method: "GET", path: "/login" })
    .reply(200, '<html><meta name="ol-csrfToken" content="csrf-token"></html>', {
      headers: { "set-cookie": "csrfToken=csrf-cookie; Path=/" }
    });
  pool
    .intercept({
      method: "POST",
      path: "/login",
      headers: { cookie: "csrfToken=csrf-cookie" },
      body: (value) => {
        const body = new URLSearchParams(value);
        assert.equal(body.get("email"), "you@example.com");
        assert.equal(body.get("password"), "secret");
        assert.equal(body.get("_csrf"), "csrf-token");
        return true;
      }
    })
    .reply(302, "", {
      headers: { "set-cookie": "sharelatex.sid=session-value; Path=/" }
    });
  pool
    .intercept({
      method: "GET",
      path: "/user/personal_info",
      headers: { cookie: "csrfToken=csrf-cookie; sharelatex.sid=session-value" }
    })
    .reply(200, { email: "you@example.com", _id: "user123" });
  try {
    const session = await loginWithPassword({
      host: origin,
      profile: "default",
      email: "you@example.com",
      password: "secret",
      sslVerify: true,
      timeoutMs: 1_000
    });
    assert.deepEqual(
      session.cookies.map((cookie) => [cookie.name, cookie.value]),
      [
        ["csrfToken", "csrf-cookie"],
        ["sharelatex.sid", "session-value"]
      ]
    );
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { cleanProjectTitle, textReplacementOperation } from "../dist/backend.js";
import { checkSession, loadSession, loginWithPassword, saveSession, sessionFromCookieHeader } from "../dist/auth.js";
import { defaultConfig, ensureProjectGitignore, writeConfig } from "../dist/config.js";
import { buildPushPlan } from "../dist/diff.js";
import { exists, removeDirectoriesByPrefix } from "../dist/files.js";
import { ensureGitRepo, gitIgnoredTrackedFiles, hasDiffBetween, headCommit, importSnapshotToBranch, mergeBase, resetHard, runGit } from "../dist/git.js";
import { globalSessionFile, hostPlatform, parseProjectLocator } from "../dist/platform.js";
import { isIgnored, normalizeProjectPath } from "../dist/snapshot.js";
import { SyncEngine } from "../dist/sync.js";

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

test("prunes stale snapshot directories by prefix", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-snaps-"));
  try {
    await fs.mkdir(path.join(dir, "snapshot-aaa"));
    await fs.mkdir(path.join(dir, "snapshot-bbb"));
    await fs.mkdir(path.join(dir, "keepme"));
    await fs.writeFile(path.join(dir, "snapshot-file"), "x");
    await removeDirectoriesByPrefix(dir, "snapshot-");
    assert.equal(await exists(path.join(dir, "snapshot-aaa")), false);
    assert.equal(await exists(path.join(dir, "snapshot-bbb")), false);
    assert.equal(await exists(path.join(dir, "keepme")), true);
    assert.equal(await exists(path.join(dir, "snapshot-file")), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test("parses Overleaf and TexPage project URLs", () => {
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
  assert.deepEqual(parseProjectLocator("https://www.texpage.com/project/user/project-key/version-no"), {
    projectId: "project-key",
    versionNo: "version-no",
    host: "https://www.texpage.com",
    platform: "texpage"
  });
});

test("freshness check ignores unpushed local commits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-freshness-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "tester"]);
    git(["config", "user.email", "tester@example.invalid"]);
    await fs.writeFile(path.join(dir, "base.tex"), "base");
    git(["add", "base.tex"]);
    git(["commit", "-m", "base"]);
    git(["branch", "texleaf-remote"]);
    await fs.writeFile(path.join(dir, "remote.tex"), "remote");
    git(["add", "remote.tex"]);
    git(["commit", "-m", "remote change"]);
    const remoteHead = git(["rev-parse", "texleaf-remote"]).trim();
    git(["merge", "--no-ff", "texleaf-remote", "-m", "merge remote"]);
    await fs.writeFile(path.join(dir, "local.tex"), "local");
    git(["add", "local.tex"]);
    git(["commit", "-m", "local change"]);
    git(["checkout", "texleaf-remote"]);
    git(["commit", "--allow-empty", "-m", "overleaf: freshness snapshot"]);
    git(["checkout", "main"]);
    // Old buggy check: branch trees always differ while local commits are unpushed.
    assert.equal(hasDiffBetween(dir, "texleaf-remote", "main"), true);
    // Fixed check: remote has no new content relative to the merge base.
    const base = mergeBase(dir, "texleaf-remote", "main");
    assert.equal(base, remoteHead);
    assert.equal(hasDiffBetween(dir, base, "texleaf-remote"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeSyncFixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-sync-push-history-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const config = defaultConfig({
    repoRoot: repo, host: "https://www.texpage.com", projectId: "project-key", ownerKey: "owner-key",
    versionNo: "version-key", projectName: "sync-test", platform: "texpage", sessionFile: "session.json"
  });
  config.ignore.patterns.push("local-private.txt");
  await writeConfig(repo, config);
  ensureGitRepo(repo, config.git.mainBranch);
  const remote = new Map([["paper.tex", "base paper\n"]]);
  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-sync-push-snapshot-"));
  t.after(() => fs.rm(snapshot, { recursive: true, force: true }));
  await fs.writeFile(path.join(snapshot, "paper.tex"), remote.get("paper.tex"));
  await importSnapshotToBranch({ repo, snapshotDir: snapshot, branch: config.git.remoteBranch, patterns: config.ignore.patterns, message: "initial remote" });
  resetHard(repo, config.git.remoteBranch);
  await ensureProjectGitignore(repo);
  await fs.writeFile(path.join(repo, "local-private.txt"), "tracked and ignored by texleaf\n");
  runGit(repo, ["add", ".gitignore", "local-private.txt"]);
  runGit(repo, ["-c", "user.name=texleaf", "-c", "user.email=texleaf@example.invalid", "commit", "-m", "local ignored files"], { identity: true });
  const writes = [];
  const backend = {
    async authenticate() {},
    async projectName() { return "sync-test"; },
    async downloadSnapshot(_id, dir) {
      for (const [projectPath, content] of remote) {
        const target = path.join(dir, projectPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    },
    async createFolder(_id, projectPath) { writes.push(["folder", projectPath]); },
    async writeTextFile(_id, projectPath, content) { writes.push(["text", projectPath]); remote.set(projectPath, content); },
    async uploadBinaryFile(_id, projectPath, content) { writes.push(["binary", projectPath]); remote.set(projectPath, Buffer.from(content)); },
    async deletePath(_id, projectPath) { writes.push(["delete", projectPath]); remote.delete(projectPath); },
    async movePath(_id, oldPath, newPath) {
      writes.push(["move", oldPath, newPath]);
      if (!remote.has(oldPath)) throw new Error(`missing ${oldPath}`);
      remote.set(newPath, remote.get(oldPath));
      remote.delete(oldPath);
    }
  };
  const engine = new SyncEngine(repo, () => backend);
  const git = (args) => runGit(repo, args).stdout.trim();
  const commit = (message) => {
    runGit(repo, ["add", "-A", "--", "."]);
    runGit(repo, ["-c", "user.name=texleaf", "-c", "user.email=texleaf@example.invalid", "commit", "-m", message], { identity: true });
  };
  return { repo, config, remote, writes, backend, engine, git, commit };
}

test("successive push snapshots anchor the verified HEAD and preserve ignored files", async (t) => {
  const { repo, config, remote, writes, engine, git, commit } = await makeSyncFixture(t);
  const steps = [
    async () => { await fs.writeFile(path.join(repo, "added.tex"), "new file\n"); commit("add file"); },
    async () => { await fs.writeFile(path.join(repo, "paper.tex"), "modified paper\n"); commit("modify existing file"); },
    async () => { await fs.mkdir(path.join(repo, "nested"), { recursive: true }); await fs.rename(path.join(repo, "added.tex"), path.join(repo, "nested", "moved.tex")); commit("move file"); },
    async () => {
      await fs.rm(path.join(repo, "nested", "moved.tex"));
      runGit(repo, ["rm", ".gitignore", "local-private.txt"]);
      await fs.writeFile(path.join(repo, "paper.tex"), "modified after removing ignored files\n");
      commit("delete fixture and tracked ignored files");
    },
    async () => { await fs.writeFile(path.join(repo, "paper.tex"), "final paper\n"); commit("continue after ignored-file removal"); }
  ];
  for (const [stepIndex, prepare] of steps.entries()) {
    await prepare();
    if (stepIndex === 3) {
      const headBeforePull = git(["rev-parse", "HEAD"]);
      await engine.pull();
      assert.equal(git(["rev-parse", "HEAD"]), headBeforePull, "ignored-file deletion must not trigger a fake remote merge on pull");
      assert.notEqual(runGit(repo, ["cat-file", "-e", "HEAD:.gitignore"], { check: false }).code, 0, "pull must not restore a locally deleted ignored file");
    }
    const localHead = git(["rev-parse", "HEAD"]);
    const writesBefore = writes.length;
    await engine.push();
    assert.equal(git(["rev-parse", "HEAD"]), localHead, "a no-change freshness check must not move or merge the local branch");
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).texleaf"]), "", "push must leave the worktree clean");
    assert.equal(mergeBase(repo, config.git.remoteBranch, "main"), localHead, "the verified local HEAD must be an ancestor of the remote snapshot");
    assert.equal(hasDiffBetween(repo, localHead, config.git.remoteBranch), false, "verified snapshot tree should match the local project tree");
    const localIgnoreExists = runGit(repo, ["cat-file", "-e", "HEAD:.gitignore"], { check: false }).code === 0;
    const remoteIgnoreExists = runGit(repo, ["cat-file", "-e", `${config.git.remoteBranch}:.gitignore`], { check: false }).code === 0;
    const remotePrivateExists = runGit(repo, ["cat-file", "-e", `${config.git.remoteBranch}:local-private.txt`], { check: false }).code === 0;
    assert.equal(remoteIgnoreExists, localIgnoreExists, "the snapshot must preserve the local ignored-file set");
    assert.equal(remotePrivateExists, localIgnoreExists, "custom ignored files must follow the verified local tree");
    if (localIgnoreExists) assert.match(git(["show", `${config.git.remoteBranch}:.gitignore`]), /\.texleaf\//);
    const plannedPaths = writes.slice(writesBefore).map((entry) => entry[1]);
    assert.equal(plannedPaths.includes(".gitignore"), false);
    assert.equal(plannedPaths.includes("local-private.txt"), false);
  }
  assert.deepEqual([...remote.keys()].sort(), ["paper.tex"]);
  assert.equal(remote.get("paper.tex"), "final paper\n");
});

test("a real remote edit still triggers a conflict before any push write", async (t) => {
  const { repo, remote, writes, engine, git, commit } = await makeSyncFixture(t);
  await fs.writeFile(path.join(repo, "first.tex"), "first\n");
  commit("initial push");
  await engine.push();
  await fs.writeFile(path.join(repo, "paper.tex"), "local concurrent edit\n");
  commit("local edit");
  remote.set("paper.tex", "remote concurrent edit\n");
  const localHead = git(["rev-parse", "HEAD"]);
  const writesBefore = writes.length;
  await assert.rejects(engine.push(), /CONFLICT|merge/i);
  assert.equal(git(["rev-parse", "HEAD"]), localHead, "conflicted freshness must keep the local HEAD unchanged");
  assert.deepEqual(git(["diff", "--name-only", "--diff-filter=U"]).split(/\r?\n/).filter(Boolean), ["paper.tex"]);
  assert.equal(writes.length, writesBefore, "remote changes must be reconciled before push operations start");
});

test("excludes gitignored tracked files from the push plan", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-dsstore-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "tester"]);
    git(["config", "user.email", "tester@example.invalid"]);
    await fs.writeFile(path.join(dir, ".gitignore"), ".DS_Store\n");
    await fs.writeFile(path.join(dir, "main.tex"), "paper");
    git(["add", ".gitignore", "main.tex"]);
    git(["commit", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    await fs.writeFile(path.join(dir, ".DS_Store"), "junk");
    git(["add", "-f", ".DS_Store"]);
    git(["commit", "-m", "junk"]);
    assert.deepEqual(gitIgnoredTrackedFiles(dir), [".DS_Store"]);
    const plan = await buildPushPlan(dir, base, []);
    assert.deepEqual(plan, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test("checks TexPage sessions from the project total status", async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const pool = mockAgent.get("https://www.texpage.com");
  pool.intercept({ method: "GET", path: /^\/api\/project\/total\?t=\d+$/ }).reply(200, { status: { code: 1 } });
  pool.intercept({ method: "GET", path: /^\/api\/project\/total\?t=\d+$/ }).reply(200, { status: { code: 0 } });
  const session = sessionFromCookieHeader({ host: "https://www.texpage.com", profile: "default", cookieHeader: "SESSIONID=secret", sslVerify: true });
  try {
    assert.deepEqual(await checkSession({ host: session.host, session }), { loggedIn: true });
    assert.deepEqual(await checkSession({ host: session.host, session }), { loggedIn: false, error: "TexPage session was rejected." });
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
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

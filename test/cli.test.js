import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("clone help uses positional project locator", () => {
  const output = execFileSync(process.execPath, ["dist/cli.js", "clone", "--help"], { encoding: "utf8" });
  assert.match(output, /Usage: texleaf clone \[options\] <project> \[directory\]/);
  assert.match(output, /Overleaf project id or project URL/);
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

test("failed Chrome imports preserve an existing saved session", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.json");
  const original = '{"saved":"keep-existing-session"}\n';
  await fs.writeFile(sessionFile, original, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    "dist/cli.js", "auth", "login", "--platform", "cstcloud", "--from-chrome",
    "--chrome-profile", path.join(directory, "missing-profile"), "--session-file", sessionFile
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No saved Chrome session cookies|macOS only/);
  assert.equal(await fs.readFile(sessionFile, "utf8"), original);
});

test("--from-chrome without a target checks every supported platform", { skip: process.platform !== "darwin" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-chrome-batch-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "dist/cli.js", "auth", "login", "--from-chrome", "--chrome-profile", directory
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Checking cstcloud/);
  assert.match(result.stdout, /Checking overleaf/);
  assert.match(result.stdout, /Manual login needed for: cstcloud, overleaf/);
  assert.match(result.stderr, /in a terminal to enter cookies manually/);
  assert.doesNotMatch(result.stdout, /Platform \[1\]/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OverleafBackend } from "../dist/backend.js";
import { defaultConfig } from "../dist/config.js";

// The snapshot download streams the response body to disk before extraction;
// this covers the backpressure-aware write path with a real archive.
test("streams a snapshot response to disk and extracts it", async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-download-source-"));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-download-repo-"));
  const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "texleaf-download-dest-"));
  t.after(() => Promise.all([source, repoRoot, destDir].map((dir) => fs.rm(dir, { recursive: true, force: true }))));
  await fs.mkdir(path.join(source, "sections"), { recursive: true });
  await fs.writeFile(path.join(source, "paper.tex"), "hello paper\n");
  await fs.writeFile(path.join(source, "sections", "intro.tex"), "hello intro\n");
  execFileSync("/usr/bin/zip", ["-qr", path.join(source, "snapshot.zip"), "."], { cwd: source });
  const archive = await fs.readFile(path.join(source, "snapshot.zip"));

  const config = defaultConfig({
    repoRoot,
    host: "https://www.overleaf.com",
    projectId: "project-id",
    projectName: "Download test"
  });
  const backend = new OverleafBackend(repoRoot, config);
  backend.request = async () =>
    new Response(archive, {
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(archive.length) }
    });

  await backend.downloadSnapshot("project-id", destDir);
  assert.equal(await fs.readFile(path.join(destDir, "paper.tex"), "utf8"), "hello paper\n");
  assert.equal(await fs.readFile(path.join(destDir, "sections", "intro.tex"), "utf8"), "hello intro\n");
  assert.deepEqual((await fs.readdir(destDir)).sort(), ["paper.tex", "sections"]);
});

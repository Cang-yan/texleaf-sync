import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { saveSession, sessionFromCookieHeader } from "../dist/auth.js";
import { defaultConfig } from "../dist/config.js";
import { SyncEngine } from "../dist/sync.js";
import { buildTextOperations, nextActorSequence, splitOperationBatches, TexPageBackend, uploadObject, validateJoinedHistory } from "../dist/texpage-backend.js";

test("builds a deletion-only operation for empty text and batches text above 100 splices", () => {
  const empty = buildTextOperations("", "file", "version", "account-site", 8, { "account-site": 7 });
  assert.equal(empty.length, 1);
  assert.equal(Object.hasOwn(empty[0].operation, "insertion"), false);
  assert.equal(empty[0].operation.spliceId.seq, 8);

  const many = buildTextOperations("x".repeat(20_001), "file", "version", "account-site", 8, { "account-site": 7 });
  assert.equal(many.length, 101);
  assert.equal(many[0].operation.spliceId.seq, 8);
  assert.equal(many[100].operation.spliceId.seq, 108);
  assert.equal(many[100].operation.insertion.text.length, 1);
  assert.deepEqual(splitOperationBatches(many, 100).map((batch) => batch.length), [100, 1]);
  assert.equal(nextActorSequence("account-site", [
    { spliceId: { site: "account-site", seq: 5 } },
    { spliceId: { site: "other-site", seq: 99 } }
  ]), 6);
});

test("refuses to write from a partial joinedDoc operation history", () => {
  assert.doesNotThrow(() => validateJoinedHistory({ current: 5, total: 5, operations: Array(5).fill({}) }));
  assert.throws(() => validateJoinedHistory({ current: 1, total: 2, operations: Array(2).fill({}) }), /incomplete document history/);
  assert.throws(() => validateJoinedHistory({ current: 2, total: 2, operations: Array(1).fill({}) }), /incomplete document history/);
});

test("uploads binary bytes to object storage without forwarding TexPage cookies", async (t) => {
  let seen;
  const originalHandle = NodeHttpHandler.prototype.handle;
  NodeHttpHandler.prototype.handle = async function (request) {
    const payload = Buffer.isBuffer(request.body) || request.body instanceof Uint8Array ? Buffer.from(request.body) : Buffer.alloc(0);
    seen = { hostname: request.hostname, hostHeader: request.headers.host, path: request.path, cookie: request.headers.cookie, authorization: request.headers.authorization, body: payload };
    return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
  };
  t.after(() => { NodeHttpHandler.prototype.handle = originalHandle; });
  await uploadObject({
    accessKeyId: "test-access-key", accessKeySecret: "test-secret", stsToken: "test-sts-token",
    expiration: new Date(Date.now() + 60_000).toISOString(), region: "us-east-1", bucket: "texpage-test",
    endpoint: "https://s3.example.test", uploadDomain: "upload.example.test", forcePathStyle: true
  }, "user-key/object-id", Buffer.from([0, 1, 2, 255]), 2_000, true);
  assert.equal(seen.hostname, "upload.example.test");
  assert.equal(seen.hostHeader, "upload.example.test");
  assert.match(seen.path, /^\/texpage-test\/user-key\/object-id/);
  assert.equal(seen.cookie, undefined);
  assert.match(seen.authorization, /^AWS4-HMAC-SHA256 /);
  assert.deepEqual(seen.body, Buffer.from([0, 1, 2, 255]));
});

test("rejects insecure external object-storage endpoints before sending credentials", async () => {
  await assert.rejects(uploadObject({
    accessKeyId: "test", accessKeySecret: "test", stsToken: "test", expiration: new Date(Date.now() + 60_000).toISOString(),
    region: "us-east-1", bucket: "bucket", endpoint: "http://localhost"
  }, "key", Buffer.from("data"), 1000, true), /insecure object-storage endpoint/);
});

test("does not treat an object upload as complete when file registration fails", async (t) => {
  const { backend, mockAgent } = await fixture(t);
  mockAgent.get("https://storage.example.test").intercept({ method: "PUT", path: "/upload" }).reply(200);
  const ref = { ownerKey: "owner-key", projectKey: "wanted-project-key", versionNo: "version-key", projectName: "test" };
  backend.resolveProject = async () => ref;
  backend.getJson = async (route) => route === "/api/user/info"
    ? { userKey: "account-key" }
    : { url: "https://storage.example.test/upload" };
  let treeReads = 0;
  backend.fileTree = async () => { treeReads++; return []; };
  backend.parentKey = async () => "0";
  let registered = false;
  backend.request = async (route) => {
    assert.equal(route, "/api/project/file");
    registered = true;
    return new Response(JSON.stringify({ status: { code: 0 } }), { status: 200 });
  };
  await assert.rejects(backend.uploadBinaryFile("wanted-project-key", "image.png", Buffer.from([1, 2])), /upload registration failed \(status: 0\)/);
  assert.equal(registered, true);
  assert.equal(treeReads, 1, "a failed registration must not be followed by a success tree check");
});

test("R100 moves skip content writes while changed renames write the destination", async (t) => {
  const { backend, config } = await fixture(t);
  const calls = [];
  const fake = {
    createFolder: async (_id, p) => calls.push(["folder", p]),
    movePath: async (_id, from, to) => calls.push(["move", from, to]),
    writeTextFile: async (_id, p, content) => calls.push(["text", p, content]),
    uploadBinaryFile: async (_id, p) => calls.push(["binary", p])
  };
  await fs.mkdir(path.join(backend.repoRoot, "relocated"), { recursive: true });
  await fs.writeFile(path.join(backend.repoRoot, "relocated", "unchanged.png"), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(backend.repoRoot, "relocated", "changed.tex"), "updated text");
  const engine = new SyncEngine(backend.repoRoot);
  await engine.applyPushPlan(config, fake, [
    { status: "R100", oldPath: "old/image.png", path: "relocated/unchanged.png", isText: false },
    { status: "R90", oldPath: "old/paper.tex", path: "relocated/changed.tex", isText: true }
  ]);
  assert.deepEqual(calls, [
    ["folder", "relocated"], ["move", "old/image.png", "relocated/unchanged.png"],
    ["folder", "relocated"], ["move", "old/paper.tex", "relocated/changed.tex"],
    ["text", "relocated/changed.tex", "updated text"]
  ]);
});

async function fixture(t, { pinnedVersion } = {}) {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texpage-backend-test-"));
  t.after(async () => {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const sessionFile = path.join(dir, "session.json");
  const session = sessionFromCookieHeader({ host: "https://www.texpage.com", profile: "default", cookieHeader: "SESSIONID=redacted-test", sslVerify: true });
  await saveSession(sessionFile, session);
  const config = defaultConfig({
    repoRoot: dir,
    host: session.host,
    projectId: "wanted-project-key",
    projectName: "Pinned paper",
    platform: "texpage",
    sessionFile,
    versionNo: pinnedVersion
  });
  const backend = new TexPageBackend(dir, config);
  return { backend, pool: mockAgent.get(session.host), config, mockAgent };
}

test("resolves a pinned TexPage project and honors the URL-pinned version", async (t) => {
  const { backend, pool } = await fixture(t);
  pool.intercept({ method: "GET", path: /^\/api\/project\/total/ }).reply(200, { status: { code: 1 } });
  await backend.authenticate();
  backend.config.project.versionNo = "url-pinned-version";
  backend.request = async () => new Response(JSON.stringify({
    status: { code: 1 },
    result: {
      pinnedList: [{ projectKey: "wanted-project-key", ownerKey: "owner-key", projectName: "Pinned paper", selectedVersion: { versionNo: "listed-version" } }],
      list: []
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await backend.projectIdentity("wanted-project-key"), {
    projectName: "Pinned paper",
    ownerKey: "owner-key",
    versionNo: "url-pinned-version"
  });
});

test("uses the selected listed TexPage version and does not cache project names as IDs", async (t) => {
  const { backend, pool } = await fixture(t);
  pool.intercept({ method: "GET", path: /^\/api\/project\/total/ }).reply(200, { status: { code: 1 } });
  pool.intercept({ method: "GET", path: /^\/api\/project(?!\/total)/ }).reply(200,
    { status: { code: 1 }, result: { pinnedList: [{ projectKey: "wanted-project-key", ownerKey: "owner-key", projectName: "Pinned paper", selectedVersion: { versionNo: "selected-version" } }], list: [] } });
  pool.intercept({ method: "GET", path: /^\/api\/project(?!\/total)/ }).reply(200,
    { status: { code: 1 }, result: { pinnedList: [], list: [] } });
  pool.intercept({ method: "GET", path: /^\/api\/project(?!\/total)/ }).reply(200,
    { status: { code: 1 }, result: { pinnedList: [], list: [] } });
  await backend.authenticate();
  assert.equal((await backend.projectIdentity("wanted-project-key")).versionNo, "selected-version");
  await assert.rejects(backend.projectName("Pinned paper"), /TexPage project not found/);
});

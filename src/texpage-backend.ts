import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import WebSocket from "ws";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import { type AuthSession, checkSession, cookieHeader, fetchWithTimeout, loadSession } from "./auth.js";
import type { TexleafConfig } from "./config.js";
import { resolveRepoPath } from "./config.js";
import { BackendError } from "./errors.js";
import type { Entity } from "./backend.js";
import { normalizeHost } from "./platform.js";
import { normalizeProjectPath, safeExtractZip } from "./snapshot.js";

interface ProjectRef {
  ownerKey: string;
  projectKey: string;
  versionNo: string;
  projectName: string;
}

interface TreeFile {
  fileKey: string;
  filePath: string;
  isDir: boolean;
  fileType?: string;
}

export class TexPageBackend {
  readonly host: string;
  private session?: AuthSession;
  private refs = new Map<string, ProjectRef>();

  constructor(private readonly repoRoot: string, private readonly config: TexleafConfig) {
    this.host = normalizeHost(config.project.host);
  }

  async authenticate(): Promise<void> {
    this.session = await loadSession(resolveRepoPath(this.repoRoot, this.config.auth.sessionFile), this.host);
    this.session = { ...this.session, sslVerify: this.config.backend.sslVerify };
    const status = await checkSession({ host: this.host, session: this.session, timeoutMs: this.config.backend.timeoutMs });
    if (!status.loggedIn) throw new BackendError(`TexPage session is not logged in: ${status.error ?? "unknown error"}\nPlease log in again: texleaf auth login --platform texpage --from-chrome`);
  }

  async projectName(projectId: string): Promise<string | undefined> {
    return (await this.resolveProject(projectId)).projectName;
  }

  async projectIdentity(projectId: string): Promise<{ projectName: string; ownerKey: string; versionNo: string }> {
    const { projectName, ownerKey, versionNo } = await this.resolveProject(projectId);
    return { projectName, ownerKey, versionNo };
  }

  async downloadSnapshot(projectId: string, destDir: string): Promise<void> {
    const ref = await this.resolveProject(projectId);
    const response = await this.request(`/api/project/download?${new URLSearchParams({ projectKey: ref.projectKey, versionNo: ref.versionNo })}`);
    const tempDir = await fs.mkdtemp(path.join(path.dirname(destDir), "texleaf-texpage-"));
    const zipPath = path.join(tempDir, "snapshot.zip");
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") {
        throw new BackendError("TexPage source download did not return a ZIP archive.");
      }
      await fs.writeFile(zipPath, bytes, { mode: 0o600 });
      await safeExtractZip(zipPath, destDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async writeTextFile(projectId: string, projectPath: string, content: string): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    let file = (await this.fileTree(ref)).find((item) => item.filePath === normalized && !item.isDir);
    if ((file && file.fileType && !file.fileType.startsWith("text/")) || (!file && path.posix.extname(normalized).toLowerCase() === ".svg")) {
      await this.uploadBinaryFile(projectId, normalized, Buffer.from(content, "utf8"));
      return;
    }
    if (!file) {
      const parentKey = await this.parentKey(ref, path.posix.dirname(normalized));
      await this.projectAction(ref, "post:/api/project/file", {
        addType: "normal", fileName: path.posix.basename(normalized), isDir: false, ownerKey: ref.ownerKey,
        parentKey, projectKey: ref.projectKey, versionNo: ref.versionNo
      });
      file = (await this.fileTree(ref)).find((item) => item.filePath === normalized && !item.isDir);
    }
    if (!file) throw new BackendError(`TexPage did not create the requested text file: ${normalized}`);
    if (file.fileType && !file.fileType.startsWith("text/")) {
      await this.uploadBinaryFile(projectId, normalized, Buffer.from(content, "utf8"));
      return;
    }
    await replaceDocument(this.requireSession(), ref, file.fileKey, content, this.config.backend.timeoutMs);
  }

  async uploadBinaryFile(projectId: string, projectPath: string, content: Buffer): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    const user = await this.getJson("/api/user/info");
    const userKey = user.userKey;
    if (typeof userKey !== "string" || !userKey) throw new BackendError("TexPage did not provide the account key needed for upload.");
    const key = `${userKey}/${crypto.randomUUID()}`;
    const tokenData = await this.getJson(`/api/user/uploadToken?${new URLSearchParams({ folder: userKey, key })}`);
    await uploadObject(tokenData, key, content, this.config.backend.timeoutMs, this.config.backend.sslVerify);

    const existing = (await this.fileTree(ref)).find((entry) => entry.filePath === normalized && !entry.isDir);
    const parentKey = await this.parentKey(ref, path.posix.dirname(normalized));
    const response = await this.request("/api/project/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addType: "upload", ownerKey: ref.ownerKey, projectKey: ref.projectKey, versionNo: ref.versionNo,
        isDir: false, parentKey, fileName: path.posix.basename(normalized), key, overwrite: Boolean(existing)
      })
    });
    await readMutationResponse(response, "upload registration");
    const uploaded = (await this.fileTree(ref)).find((entry) => entry.filePath === normalized && !entry.isDir);
    if (!uploaded) throw new BackendError(`TexPage did not register the uploaded file: ${normalized}`);
  }

  async createFolder(projectId: string, projectPath: string): Promise<Entity> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    const parts = normalized.split("/");
    let current = "";
    let folder: TreeFile | undefined;
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const files = await this.fileTree(ref);
      folder = files.find((entry) => entry.filePath === current && entry.isDir);
      if (!folder) {
        const parentKey = current.includes("/") ? await this.parentKey(ref, path.posix.dirname(current)) : "0";
        await this.projectAction(ref, "post:/api/project/file", {
          addType: "normal", fileName: part, isDir: true, ownerKey: ref.ownerKey, parentKey,
          projectKey: ref.projectKey, versionNo: ref.versionNo
        });
        folder = (await this.fileTree(ref)).find((entry) => entry.filePath === current && entry.isDir);
        if (!folder) throw new BackendError(`TexPage did not create the requested folder: ${current}`);
      }
    }
    if (!folder) throw new BackendError("TexPage folder path is empty.");
    return { id: folder.fileKey, name: path.posix.basename(normalized), type: "folder", path: normalized, children: [] };
  }

  async deletePath(projectId: string, projectPath: string): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    const file = (await this.fileTree(ref)).find((entry) => entry.filePath === normalized);
    if (!file) return;
    await this.projectAction(ref, "delete:/api/project/file", {
      fileKey: file.fileKey, ownerKey: ref.ownerKey, projectKey: ref.projectKey, versionNo: ref.versionNo
    });
    if ((await this.fileTree(ref)).some((entry) => entry.filePath === normalized)) {
      throw new BackendError(`TexPage did not delete the requested path: ${normalized}`);
    }
  }

  async movePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = normalizeProjectPath(oldPath);
    const newNormalized = normalizeProjectPath(newPath);
    const ref = await this.resolveProject(projectId);
    const source = (await this.fileTree(ref)).find((entry) => entry.filePath === oldNormalized);
    if (!source) throw new BackendError(`TexPage move source does not exist: ${oldNormalized}`);
    if ((await this.fileTree(ref)).some((entry) => entry.filePath === newNormalized)) {
      throw new BackendError(`TexPage move destination already exists: ${newNormalized}`);
    }
    const parentKey = await this.parentKey(ref, path.posix.dirname(newNormalized));
    if (path.posix.dirname(oldNormalized) !== path.posix.dirname(newNormalized)) {
      await this.projectAction(ref, "put:/api/project/moveFile", {
        fileKey: source.fileKey, parentKey, projectKey: ref.projectKey, versionNo: ref.versionNo
      });
    }
    if (path.posix.basename(oldNormalized) !== path.posix.basename(newNormalized)) {
      await this.projectAction(ref, "put:/api/project/file/name", {
        fileKey: source.fileKey, fileName: path.posix.basename(newNormalized), ownerKey: ref.ownerKey,
        projectKey: ref.projectKey, versionNo: ref.versionNo
      });
    }
    const tree = await this.fileTree(ref);
    const moved = tree.find((entry) => entry.filePath === newNormalized);
    if (!moved || moved.fileKey !== source.fileKey || (oldNormalized !== newNormalized && tree.some((entry) => entry.filePath === oldNormalized))) {
      throw new BackendError(`TexPage did not move the requested path: ${oldNormalized} -> ${newNormalized}`);
    }
  }

  private async parentKey(ref: ProjectRef, parentPath: string): Promise<string> {
    if (parentPath === ".") return "0";
    const parent = (await this.fileTree(ref)).find((entry) => entry.filePath === parentPath && entry.isDir);
    if (!parent) throw new BackendError(`TexPage parent folder does not exist: ${parentPath}`);
    return parent.fileKey;
  }

  private async projectAction(ref: ProjectRef, action: string, data: Record<string, unknown>): Promise<Record<string, any>> {
    const socket = new WebSocket("wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket", {
      headers: { Cookie: cookieHeader(this.requireSession()), Origin: "https://www.texpage.com" },
      rejectUnauthorized: this.requireSession().sslVerify
    });
    const deadline = Date.now() + this.config.backend.timeoutMs;
    const frames = new SocketFrameQueue(socket, deadline);
    try {
      await waitSocketOpen(socket, deadline);
      await expectSocketFrame(frames, (frame) => frame.startsWith("0"));
      socket.send("40");
      await expectSocketFrame(frames, (frame) => frame.startsWith("40"));
      const joinId = crypto.randomUUID();
      socket.send(socketEvent("request", { request: { requestId: joinId, action: "post:/api/project/joinRoom" }, data: { projectKey: ref.projectKey, versionNo: ref.versionNo } }));
      const joined = await expectSocketEvent(frames, (name, payload) => name === "response" && payload.requestId === joinId);
      if (joined.status?.code !== 1) throw new BackendError("TexPage rejected project join before file operation.");
      const requestId = crypto.randomUUID();
      socket.send(socketEvent("request", { request: { requestId, action }, data }));
      const response = await expectSocketEvent(frames, (name, payload) => name === "response" && payload.requestId === requestId);
      if (response.status?.code !== 1) {
        throw new BackendError(`TexPage file operation failed (status: ${String(response.status?.code ?? "unknown")}).`);
      }
      return response.result && typeof response.result === "object" ? response.result : {};
    } finally {
      socket.close();
    }
  }

  private async resolveProject(projectId: string): Promise<ProjectRef> {
    const cached = this.refs.get(projectId);
    if (cached) return cached;
    for (let page = 1; page <= 20; page++) {
      const result = await this.getJson(`/api/project?${new URLSearchParams({ page: String(page), projectName: "", sortBy: "updateAt", getType: "all", t: String(Date.now()) })}`);
      const pinned = Array.isArray(result.pinnedList) ? result.pinnedList as Record<string, any>[] : [];
      const regular = Array.isArray(result.list) ? result.list as Record<string, any>[] : [];
      const list = [...pinned, ...regular];
      const item = list.find((project) => project.projectKey === projectId);
      if (item) {
        const listedVersion = item.selectedVersion?.versionNo ?? item.versionNos?.[0]?.versionNo;
        const versionNo = this.config.project.versionNo ?? listedVersion;
        if (typeof item.ownerKey !== "string" || typeof item.projectKey !== "string" || typeof versionNo !== "string") {
          throw new BackendError("TexPage returned incomplete project identity or version data.");
        }
        const ref = { ownerKey: item.ownerKey, projectKey: item.projectKey, versionNo, projectName: String(item.projectName ?? projectId) };
        this.refs.set(projectId, ref);
        this.refs.set(ref.projectKey, ref);
        return ref;
      }
      if (!list.length) break;
    }
    throw new BackendError(`TexPage project not found: ${projectId}`);
  }

  private async fileTree(ref: ProjectRef): Promise<TreeFile[]> {
    const data = await this.getJson(`/api/project/fileTree?${new URLSearchParams({ ownerKey: ref.ownerKey, projectKey: ref.projectKey, versionNo: ref.versionNo })}`);
    if (!Array.isArray(data.treeData)) throw new BackendError("TexPage returned a malformed project file tree.");
    return data.treeData as TreeFile[];
  }

  private async getJson(route: string): Promise<Record<string, any>> {
    const response = await this.request(route);
    const data = await response.json() as { status?: { code?: number; message?: string }; result?: unknown };
    if (data.status?.code !== 1) throw new BackendError(`TexPage API request failed: ${data.status?.message ?? "unexpected response"}`);
    if (!data.result || typeof data.result !== "object") throw new BackendError("TexPage returned an empty API result.");
    return data.result as Record<string, any>;
  }

  private async request(route: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers) init.headers.forEach((value, key) => { headers[key] = value; });
    else if (Array.isArray(init.headers)) for (const [key, value] of init.headers) headers[key] = value;
    else if (init.headers) Object.assign(headers, init.headers);
    headers.Accept = "application/json, application/zip, text/plain, */*";
    headers.Cookie = cookieHeader(this.requireSession());
    const response = await fetchWithTimeout(`${this.host}${route}`, {
      ...init,
      headers,
      redirect: "manual",
      timeoutMs: this.config.backend.timeoutMs,
      sslVerify: this.config.backend.sslVerify
    });
    if (response.status < 200 || response.status >= 300) throw new BackendError(`TexPage request failed with HTTP ${response.status}.`);
    return response;
  }

  private requireSession(): AuthSession {
    if (!this.session) throw new BackendError("Backend is not authenticated.");
    return this.session;
  }
}

async function readMutationResponse(response: Response, operation: string): Promise<Record<string, any>> {
  let body: { status?: { code?: number }; result?: unknown };
  try { body = await response.json() as typeof body; } catch {
    throw new BackendError(`TexPage ${operation} returned an invalid response.`);
  }
  if (body.status?.code !== 1) {
    throw new BackendError(`TexPage ${operation} failed (status: ${String(body.status?.code ?? "unknown")}).`);
  }
  return body.result && typeof body.result === "object" ? body.result as Record<string, any> : {};
}

export async function uploadObject(token: Record<string, any>, key: string, body: Buffer, timeoutMs: number, sslVerify: boolean): Promise<void> {
  if (typeof token.url === "string") {
    let url: URL;
    try { url = new URL(token.url); } catch { throw new BackendError("TexPage returned an invalid upload URL."); }
    if (url.protocol !== "https:" || url.username || url.password) throw new BackendError("TexPage returned an unsafe upload URL.");
    const response = await fetchWithTimeout(url.toString(), {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(body),
      redirect: "error", timeoutMs, sslVerify
    });
    if (!response.ok) throw new BackendError(`TexPage object upload failed with HTTP ${response.status}.`);
    return;
  }
  const { accessKeyId, accessKeySecret, stsToken, expiration, region, bucket, endpoint, uploadDomain, forcePathStyle } = token;
  if (![accessKeyId, accessKeySecret, stsToken, expiration, region, bucket, endpoint].every((value) => typeof value === "string" && value.length > 0)) {
    throw new BackendError("TexPage returned incomplete object-storage upload credentials.");
  }
  let endpointUrl: URL;
  try { endpointUrl = new URL(endpoint); } catch { throw new BackendError("TexPage returned an invalid object-storage endpoint."); }
  if (endpointUrl.protocol !== "https:") {
    throw new BackendError("TexPage returned an insecure object-storage endpoint.");
  }
  if (endpointUrl.username || endpointUrl.password) throw new BackendError("TexPage returned an invalid object-storage endpoint.");
  if (uploadDomain !== undefined && (typeof uploadDomain !== "string" || !/^[A-Za-z0-9.-]+$/.test(uploadDomain))) {
    throw new BackendError("TexPage returned an invalid object-storage upload host.");
  }
  const expiry = Date.parse(expiration);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new BackendError("TexPage returned expired object-storage credentials.");
  const delegate = new NodeHttpHandler(uploadDomain ? {
    httpsAgent: new https.Agent({ servername: uploadDomain, rejectUnauthorized: true })
  } : undefined);
  const requestHandler = uploadDomain ? {
    handle(request: Parameters<NodeHttpHandler["handle"]>[0], options?: Parameters<NodeHttpHandler["handle"]>[1]) {
      const rewritten = request.clone();
      rewritten.hostname = uploadDomain;
      rewritten.headers.host = uploadDomain;
      return delegate.handle(rewritten, options);
    },
    destroy() { delegate.destroy(); }
  } : delegate;
  const client = new S3Client({
    region, endpoint, forcePathStyle: Boolean(forcePathStyle), requestHandler,
    credentials: { accessKeyId, secretAccessKey: accessKeySecret, sessionToken: stsToken, expiration: new Date(expiry) }
  });
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/octet-stream" }), {
      abortSignal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const status = typeof error === "object" && error && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
      : undefined;
    const cause = typeof error === "object" && error && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
    const causeName = cause instanceof Error ? cause.name : undefined;
    const code = typeof error === "object" && error && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
      : undefined;
    const causeCode = typeof cause === "object" && cause && "code" in cause && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
      : undefined;
    const details = [typeof status === "number" ? `HTTP ${status}` : undefined, code, causeCode, causeName].filter(Boolean).join(", ");
    throw new BackendError(`TexPage object upload failed (${name}${details ? `, ${details}` : ""}).`);
  } finally {
    client.destroy();
  }
}

async function replaceDocument(session: AuthSession, ref: ProjectRef, fileKey: string, text: string, timeoutMs: number): Promise<void> {
  const socket = new WebSocket("wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket", {
    headers: { Cookie: cookieHeader(session), Origin: "https://www.texpage.com" },
    rejectUnauthorized: session.sslVerify
  });
  const deadline = Date.now() + timeoutMs;
  const frames = new SocketFrameQueue(socket, deadline);
  try {
    await waitSocketOpen(socket, deadline);
    await expectSocketFrame(frames, (frame) => frame.startsWith("0"));
    socket.send("40");
    await expectSocketFrame(frames, (frame) => frame.startsWith("40"));

    const joinId = `texleaf-join-${Date.now()}`;
    socket.send(socketEvent("request", { request: { requestId: joinId, action: "post:/api/project/joinRoom" }, data: { projectKey: ref.projectKey, versionNo: ref.versionNo } }));
    const join = await expectSocketEvent(frames, (name, payload) => name === "response" && payload.requestId === joinId);
    if (join.status?.code !== 1) throw new BackendError(`TexPage rejected project join: ${join.status?.message ?? "unknown response"}`);

    socket.send(socketEvent("joinDoc", { fileKey, ownerKey: ref.ownerKey, projectKey: ref.projectKey, versionNo: ref.versionNo, v: "chunk" }));
    const joined = await expectSocketEvent(frames, (name) => name === "joinedDoc");
    const joinedFileKey = joined.data?.projectFile?.fileKey ?? joined.fileKey ?? joined.data?.fileKey;
    if (joinedFileKey !== fileKey) {
      throw new BackendError("TexPage joined a different document than requested.");
    }
    const operations = joined.data?.operations;
    if (!Array.isArray(operations)) throw new BackendError("TexPage returned malformed document operations.");
    validateJoinedHistory(joined.data);
    const maxSeqsBySite: Record<string, number> = {};
    for (const operation of operations) {
      const id = operation?.spliceId;
      if (!id || (typeof id.site !== "string" && typeof id.site !== "number") || typeof id.seq !== "number") {
        throw new BackendError("TexPage returned malformed CRDT operation metadata.");
      }
      maxSeqsBySite[String(id.site)] = Math.max(maxSeqsBySite[String(id.site)] ?? 0, id.seq);
    }
    const site = joined.data?.fileState?.userKey;
    if (typeof site !== "string" || !site) throw new BackendError("TexPage did not provide the account operation site required for writes.");
    const firstSeq = nextActorSequence(site, operations);
    const out = buildTextOperations(text, fileKey, ref.versionNo, site, firstSeq, maxSeqsBySite);
    const docVersion = joined.data?.v;
    if (typeof docVersion !== "string") throw new BackendError("TexPage did not provide the document version required for writes.");
    const batches = splitOperationBatches(out, 100);
    for (let batchNumber = 0; batchNumber < batches.length; batchNumber++) {
      const batchId = crypto.randomUUID();
      const ackId = batchNumber + 1;
      const payload = {
        batchId,
        syncType: "sync",
        operations: batches[batchNumber],
        v: docVersion,
        range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }
      };
      socket.send(socketEvent("operations", payload, ackId));
      while (true) {
        const frame = await frames.next();
        if (!isSuccessfulOperationsAck(frame, ackId, batchId)) continue;
        break;
      }
    }
  } finally {
    socket.close();
  }
}

function socketEvent(name: string, payload: unknown, ackId?: number): string {
  return `42${ackId ?? ""}${JSON.stringify([name, payload])}`;
}

export function buildTextOperations(
  text: string,
  fileKey: string,
  versionNo: string,
  site: string,
  firstSeq: number,
  maxSeqsBySite: Record<string, number>
): Array<Record<string, unknown>> {
  const chunks = splitText(text, 200);
  const out: Array<Record<string, unknown>> = [];
  const count = Math.max(1, chunks.length);
  for (let index = 0; index < count; index++) {
    const spliceId = { site, seq: firstSeq + index };
    const operation: Record<string, any> = { type: "splice", spliceId };
    if (index === 0) {
      operation.deletion = {
        spliceId,
        leftDependencyId: { site: 0, seq: 0 },
        offsetInLeftDependency: { row: 0, column: 0 },
        rightDependencyId: { site: 0, seq: 1 },
        offsetInRightDependency: { row: 0, column: 0 },
        maxSeqsBySite
      };
    }
    if (chunks[index] !== undefined) {
      operation.insertion = {
        text: chunks[index],
        leftDependencyId: index === 0 ? { site: 0, seq: 0 } : { site, seq: firstSeq + index - 1 },
        offsetInLeftDependency: index === 0 ? { row: 0, column: 0 } : extent(chunks[index - 1]),
        rightDependencyId: { site: 0, seq: 1 },
        offsetInRightDependency: { row: 0, column: 0 }
      };
    }
    out.push({ fileKey, versionNo, operation });
  }
  return out;
}

export function nextActorSequence(site: string, operations: Array<{ spliceId?: { site?: unknown; seq?: unknown } }>): number {
  return operations.reduce((max, item) => item.spliceId?.site === site && typeof item.spliceId.seq === "number" ? Math.max(max, item.spliceId.seq) : max, 0) + 1;
}

export function splitOperationBatches<T>(operations: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("Operation batch size must be a positive integer.");
  const batches: T[][] = [];
  for (let offset = 0; offset < operations.length; offset += batchSize) batches.push(operations.slice(offset, offset + batchSize));
  return batches;
}

export function isSuccessfulOperationsAck(frame: string, ackId: number, batchId: string): boolean {
  const packet = /^43(\d+)\[/.exec(frame);
  if (!packet || Number(packet[1]) !== ackId) return false;
  let callback: unknown;
  try { callback = JSON.parse(frame.slice(packet[0].length - 1)); } catch {
    throw new BackendError("TexPage returned a malformed operations callback.");
  }
  const ack = Array.isArray(callback) ? callback[0] as { batchId?: unknown; status?: unknown } : undefined;
  if (!ack || ack.batchId !== batchId || ack.status !== "ok") {
    const status = typeof ack?.status === "string" ? ack.status : "unknown";
    throw new BackendError(`TexPage rejected document operations (status: ${status}).`);
  }
  return true;
}

export function validateJoinedHistory(data: { current?: unknown; total?: unknown; operations?: unknown }): void {
  if (!Array.isArray(data.operations)) throw new BackendError("TexPage returned malformed document operations.");
  if (data.current !== undefined && data.total !== undefined && data.current !== data.total) {
    throw new BackendError("TexPage returned an incomplete document history; refusing to write.");
  }
  if (data.total !== undefined && (!Number.isInteger(data.total) || data.operations.length !== data.total)) {
    throw new BackendError("TexPage returned an incomplete document history; refusing to write.");
  }
}

export class SocketFrameQueue {
  private frames: string[] = [];
  private waiters: Array<{ resolve: (frame: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private failure?: Error;

  constructor(private readonly socket: WebSocket, private readonly deadline: number) {
    socket.on("message", (data: WebSocket.RawData) => {
      const frame = data.toString("utf8");
      if (frame === "2") { if (socket.readyState === WebSocket.OPEN) socket.send("3"); return; }
      const waiter = this.waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(frame); }
      else this.frames.push(frame);
    });
    socket.on("error", () => this.fail(new BackendError("TexPage realtime connection failed.")));
    socket.on("close", () => this.fail(new BackendError("TexPage realtime connection closed unexpectedly.")));
  }

  next(): Promise<string> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.failure) return Promise.reject(this.failure);
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new BackendError("TexPage realtime request timed out."));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new BackendError("TexPage realtime request timed out."));
        }, remaining)
      };
      this.waiters.push(waiter);
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
}

async function waitSocketOpen(socket: WebSocket, deadline: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new BackendError("TexPage realtime connection timed out."))), Math.max(0, deadline - Date.now()));
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      complete();
    };
    const onOpen = () => finish(resolve);
    const onError = () => finish(() => reject(new BackendError("TexPage realtime connection failed.")));
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function expectSocketFrame(frames: SocketFrameQueue, accept: (frame: string) => boolean): Promise<string> {
  while (true) {
    const frame = await frames.next();
    if (accept(frame)) return frame;
  }
}

export async function expectSocketEvent(frames: SocketFrameQueue, accept: (name: string, payload: any) => boolean): Promise<any> {
  while (true) {
    const frame = await frames.next();
    if (!frame.startsWith("42")) continue;
    let decoded: unknown;
    try { decoded = JSON.parse(frame.slice(2)); } catch { continue; }
    if (!Array.isArray(decoded) || typeof decoded[0] !== "string") continue;
    const [name, payload] = decoded;
    if (process.env.TEXLEAF_TEXPAGE_TRACE === "1") {
      const keys = payload && typeof payload === "object" ? Object.keys(payload as object) : [];
      const nestedKeys = (payload as any)?.data && typeof (payload as any).data === "object" ? Object.keys((payload as any).data).sort().join(",") : "-";
      const statusCode = (payload as any)?.status?.code;
      const action = typeof (payload as any)?.action === "string" ? (payload as any).action : "-";
      const resultKeys = (payload as any)?.result && typeof (payload as any).result === "object" ? Object.keys((payload as any).result).sort().join(",") : "-";
      console.error(`[texpage trace] event=${name} status=${statusCode ?? "-"} action=${action} keys=${keys.sort().join(",")} dataKeys=${nestedKeys} resultKeys=${resultKeys}`);
    }
    if (accept(name, payload)) return payload;
  }
}

function splitText(value: string, maxUnits: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maxUnits, value.length);
    if (end < value.length && end > start) {
      const prev = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function extent(value: string): { row: number; column: number } {
  const parts = value.split("\n");
  return { row: parts.length - 1, column: parts[parts.length - 1].length };
}

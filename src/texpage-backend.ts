import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { type AuthSession, type FetchInit, type HttpResponse, cookieHeader, fetchWithTimeout } from "./auth.js";
import { type TexleafConfig, resolveRepoPath } from "./config.js";
import { BackendError } from "./errors.js";
import type { Entity } from "./backend.js";
import { type JsonRecord, fieldAt, isRecord, statusCodeOf, statusMessageOf } from "./json.js";
import { hostPlatform, normalizeHost, platformSocketUrl } from "./platform.js";
import { ensureSession } from "./session.js";
import { normalizeProjectPath, safeExtractZip } from "./snapshot.js";
import {
  type OperationMetadata,
  buildTextOperations,
  nextActorSequence,
  operationBatchSize,
  splitOperationBatches,
  validateJoinedHistory
} from "./texpage-crdt.js";
import {
  SocketFrameQueue,
  expectSocketEvent,
  expectSocketFrame,
  isSuccessfulOperationsAck,
  socketEvent,
  waitSocketOpen
} from "./texpage-socket.js";
import { uploadObject } from "./texpage-upload.js";

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

interface ProjectSession {
  socket: WebSocket;
  frames: SocketFrameQueue;
}

export class TexPageBackend {
  readonly host: string;
  private session?: AuthSession;
  private refs = new Map<string, ProjectRef>();

  constructor(
    private readonly repoRoot: string,
    private readonly config: TexleafConfig,
    private readonly sessionLoader = ensureSession
  ) {
    this.host = normalizeHost(config.project.host);
  }

  async authenticate(): Promise<void> {
    this.session = undefined;
    this.refs.clear();
    const { session } = await this.sessionLoader({
      host: this.host,
      profile: this.config.auth.profile,
      sessionFile: resolveRepoPath(this.repoRoot, this.config.auth.sessionFile),
      sslVerify: this.config.backend.sslVerify,
      timeoutMs: this.config.backend.timeoutMs
    });
    this.session = session;
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
    const response = await this.request(
      `/api/project/download?${new URLSearchParams({ projectKey: ref.projectKey, versionNo: ref.versionNo })}`
    );
    const tempDir = await fsp.mkdtemp(path.join(path.dirname(destDir), "texleaf-texpage-"));
    const zipPath = path.join(tempDir, "snapshot.zip");
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") {
        throw new BackendError("TexPage source download did not return a ZIP archive.");
      }
      await fsp.writeFile(zipPath, bytes, { mode: 0o600 });
      await safeExtractZip(zipPath, destDir);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }

  async writeTextFile(projectId: string, projectPath: string, content: string): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    let file = (await this.fileTree(ref)).find((item) => item.filePath === normalized && !item.isDir);
    if ((file && isBinaryEntry(file)) || (!file && isBinaryName(normalized))) {
      await this.uploadBinaryFile(projectId, normalized, Buffer.from(content, "utf8"));
      return;
    }
    if (!file) {
      const tree = await this.fileTree(ref);
      const parentKey = await this.parentKey(ref, path.posix.dirname(normalized), tree);
      await this.projectAction(ref, "post:/api/project/file", {
        addType: "normal",
        fileName: path.posix.basename(normalized),
        isDir: false,
        ownerKey: ref.ownerKey,
        parentKey,
        projectKey: ref.projectKey,
        versionNo: ref.versionNo
      });
      file = (await this.fileTree(ref)).find((item) => item.filePath === normalized && !item.isDir);
    }
    if (!file) throw new BackendError(`TexPage did not create the requested text file: ${normalized}`);
    if (isBinaryEntry(file)) {
      await this.uploadBinaryFile(projectId, normalized, Buffer.from(content, "utf8"));
      return;
    }
    await this.replaceDocument(ref, file.fileKey, content);
  }

  async uploadBinaryFile(projectId: string, projectPath: string, content: Buffer): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    const user = await this.getJson("/api/user/info");
    const userKey = user.userKey;
    if (typeof userKey !== "string" || !userKey)
      throw new BackendError("TexPage did not provide the account key needed for upload.");
    const key = `${userKey}/${randomUUID()}`;
    const tokenData = await this.getJson(`/api/user/uploadToken?${new URLSearchParams({ folder: userKey, key })}`);
    await uploadObject(tokenData, key, content, this.config.backend.timeoutMs, this.config.backend.sslVerify);

    const tree = await this.fileTree(ref);
    const existing = tree.find((entry) => entry.filePath === normalized && !entry.isDir);
    const parentKey = await this.parentKey(ref, path.posix.dirname(normalized), tree);
    const response = await this.request("/api/project/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addType: "upload",
        ownerKey: ref.ownerKey,
        projectKey: ref.projectKey,
        versionNo: ref.versionNo,
        isDir: false,
        parentKey,
        fileName: path.posix.basename(normalized),
        key,
        overwrite: Boolean(existing)
      })
    });
    await readMutationResponse(response, "upload registration");
    const uploaded = (await this.fileTree(ref)).find((entry) => entry.filePath === normalized && !entry.isDir);
    if (!uploaded) throw new BackendError(`TexPage did not register the uploaded file: ${normalized}`);
  }

  async createFolder(projectId: string, projectPath: string): Promise<Entity> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    if (!normalized) return rootEntity();
    const parts = normalized.split("/");
    let tree = await this.fileTree(ref);
    let current = "";
    let folder: TreeFile | undefined;
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folder = tree.find((entry) => entry.filePath === current && entry.isDir);
      if (!folder) {
        const parentKey = current.includes("/") ? await this.parentKey(ref, path.posix.dirname(current), tree) : "0";
        await this.projectAction(ref, "post:/api/project/file", {
          addType: "normal",
          fileName: part,
          isDir: true,
          ownerKey: ref.ownerKey,
          parentKey,
          projectKey: ref.projectKey,
          versionNo: ref.versionNo
        });
        folder = (await this.fileTree(ref)).find((entry) => entry.filePath === current && entry.isDir);
        if (!folder) throw new BackendError(`TexPage did not create the requested folder: ${current}`);
        // Keep the local view current so the next level does not refetch the tree.
        tree = [...tree, folder];
      }
    }
    if (!folder) throw new BackendError("TexPage folder path is empty.");
    return {
      id: folder.fileKey,
      name: path.posix.basename(normalized),
      type: "folder",
      path: normalized,
      children: []
    };
  }

  async deletePath(projectId: string, projectPath: string): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const ref = await this.resolveProject(projectId);
    const file = (await this.fileTree(ref)).find((entry) => entry.filePath === normalized);
    if (!file) return;
    await this.projectAction(ref, "delete:/api/project/file", {
      fileKey: file.fileKey,
      ownerKey: ref.ownerKey,
      projectKey: ref.projectKey,
      versionNo: ref.versionNo
    });
    if ((await this.fileTree(ref)).some((entry) => entry.filePath === normalized)) {
      throw new BackendError(`TexPage did not delete the requested path: ${normalized}`);
    }
  }

  async movePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = normalizeProjectPath(oldPath);
    const newNormalized = normalizeProjectPath(newPath);
    const ref = await this.resolveProject(projectId);
    const tree = await this.fileTree(ref);
    const source = tree.find((entry) => entry.filePath === oldNormalized);
    if (!source) throw new BackendError(`TexPage move source does not exist: ${oldNormalized}`);
    if (tree.some((entry) => entry.filePath === newNormalized)) {
      throw new BackendError(`TexPage move destination already exists: ${newNormalized}`);
    }
    const parentKey = await this.parentKey(ref, path.posix.dirname(newNormalized), tree);
    if (path.posix.dirname(oldNormalized) !== path.posix.dirname(newNormalized)) {
      await this.projectAction(ref, "put:/api/project/moveFile", {
        fileKey: source.fileKey,
        parentKey,
        projectKey: ref.projectKey,
        versionNo: ref.versionNo
      });
    }
    if (path.posix.basename(oldNormalized) !== path.posix.basename(newNormalized)) {
      await this.projectAction(ref, "put:/api/project/file/name", {
        fileKey: source.fileKey,
        fileName: path.posix.basename(newNormalized),
        ownerKey: ref.ownerKey,
        projectKey: ref.projectKey,
        versionNo: ref.versionNo
      });
    }
    const movedTree = await this.fileTree(ref);
    const moved = movedTree.find((entry) => entry.filePath === newNormalized);
    if (
      !moved ||
      moved.fileKey !== source.fileKey ||
      (oldNormalized !== newNormalized && movedTree.some((entry) => entry.filePath === oldNormalized))
    ) {
      throw new BackendError(`TexPage did not move the requested path: ${oldNormalized} -> ${newNormalized}`);
    }
  }

  private async replaceDocument(ref: ProjectRef, fileKey: string, text: string): Promise<void> {
    const { socket, frames } = await this.openProjectRoom(ref);
    try {
      socket.send(
        socketEvent("joinDoc", {
          fileKey,
          ownerKey: ref.ownerKey,
          projectKey: ref.projectKey,
          versionNo: ref.versionNo,
          v: "chunk"
        })
      );
      const joined = await this.joinDocumentPayload(frames, fileKey);
      const maxSeqsBySite = collectSiteSequences(joined.operations);
      const site = isRecord(joined.fileState) ? joined.fileState.userKey : undefined;
      if (typeof site !== "string" || !site) {
        throw new BackendError("TexPage did not provide the account operation site required for writes.");
      }
      const docVersion = joined.documentVersion;
      if (typeof docVersion !== "string")
        throw new BackendError("TexPage did not provide the document version required for writes.");
      const firstSeq = nextActorSequence(site, joined.operations);
      const out = buildTextOperations(text, fileKey, ref.versionNo, site, firstSeq, maxSeqsBySite);
      const batches = splitOperationBatches(out, operationBatchSize);
      for (let batchNumber = 0; batchNumber < batches.length; batchNumber++) {
        const batchId = randomUUID();
        const ackId = batchNumber + 1;
        socket.send(
          socketEvent(
            "operations",
            {
              batchId,
              syncType: "sync",
              operations: batches[batchNumber],
              v: docVersion,
              range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }
            },
            ackId
          )
        );
        while (true) {
          const frame = await frames.next();
          if (isSuccessfulOperationsAck(frame, ackId, batchId)) break;
        }
      }
    } finally {
      socket.close();
    }
  }

  private async joinDocumentPayload(frames: SocketFrameQueue, fileKey: string): Promise<JoinedDocument> {
    const event = await expectSocketEvent(frames, (name) => name === "joinedDoc");
    const payload = isRecord(event) ? event : {};
    const data = isRecord(payload.data) ? payload.data : payload;
    const joinedFileKey = [fieldAt(data.projectFile, "fileKey"), payload.fileKey, data.fileKey].find(
      (value) => typeof value === "string"
    );
    if (joinedFileKey !== fileKey) throw new BackendError("TexPage joined a different document than requested.");
    const rawOperations = data.operations;
    if (!Array.isArray(rawOperations)) throw new BackendError("TexPage returned malformed document operations.");
    validateJoinedHistory(data);
    return {
      // Validated as an array above; entries are checked again when read.
      operations: rawOperations as OperationMetadata[],
      fileState: data.fileState,
      documentVersion: data.v
    };
  }

  private async parentKey(ref: ProjectRef, parentPath: string, tree?: TreeFile[]): Promise<string> {
    if (parentPath === ".") return "0";
    const files = tree ?? (await this.fileTree(ref));
    const parent = files.find((entry) => entry.filePath === parentPath && entry.isDir);
    if (!parent) throw new BackendError(`TexPage parent folder does not exist: ${parentPath}`);
    return parent.fileKey;
  }

  private async projectAction(ref: ProjectRef, action: string, data: JsonRecord): Promise<JsonRecord> {
    const { socket, frames } = await this.openProjectRoom(ref);
    try {
      const requestId = randomUUID();
      socket.send(socketEvent("request", { request: { requestId, action }, data }));
      const response = await expectSocketEvent(
        frames,
        (name, payload) => name === "response" && isRecord(payload) && payload.requestId === requestId
      );
      if (!isRecord(response)) throw new BackendError("TexPage file operation failed (status: unknown).");
      const status = statusCodeOf(response);
      if (status !== 1) {
        throw new BackendError(`TexPage file operation failed (status: ${String(status ?? "unknown")}).`);
      }
      return isRecord(response.result) ? response.result : {};
    } finally {
      socket.close();
    }
  }

  // Connect, complete the Engine.IO handshake and join the project room. Both
  // file operations and document writes share this sequence.
  private async openProjectRoom(ref: ProjectRef): Promise<ProjectSession> {
    const session = this.requireSession();
    const socket = new WebSocket(platformSocketUrl(hostPlatform(this.host), this.host), {
      headers: { Cookie: cookieHeader(session), Origin: this.host },
      rejectUnauthorized: session.sslVerify !== false
    });
    const deadline = Date.now() + this.config.backend.timeoutMs;
    const frames = new SocketFrameQueue(socket, deadline);
    try {
      await waitSocketOpen(socket, deadline);
      await expectSocketFrame(frames, (frame) => frame.startsWith("0"));
      socket.send("40");
      await expectSocketFrame(frames, (frame) => frame.startsWith("40"));
      const joinId = randomUUID();
      socket.send(
        socketEvent("request", {
          request: { requestId: joinId, action: "post:/api/project/joinRoom" },
          data: { projectKey: ref.projectKey, versionNo: ref.versionNo }
        })
      );
      const joined = await expectSocketEvent(
        frames,
        (name, payload) => name === "response" && isRecord(payload) && payload.requestId === joinId
      );
      if (!isRecord(joined)) throw new BackendError("TexPage rejected project join: unknown response");
      if (statusCodeOf(joined) !== 1) {
        throw new BackendError(`TexPage rejected project join: ${statusMessageOf(joined) ?? "unknown response"}`);
      }
      return { socket, frames };
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  private async resolveProject(projectId: string): Promise<ProjectRef> {
    const cached = this.refs.get(projectId);
    if (cached) return cached;
    for (let page = 1; page <= resolveProjectPageLimit; page++) {
      const result = await this.getJson(
        `/api/project?${new URLSearchParams({
          page: String(page),
          projectName: "",
          sortBy: "updateAt",
          getType: "all",
          t: String(Date.now())
        })}`
      );
      const pinned = Array.isArray(result.pinnedList) ? (result.pinnedList as Record<string, unknown>[]) : [];
      const regular = Array.isArray(result.list) ? (result.list as Record<string, unknown>[]) : [];
      const list = [...pinned, ...regular];
      const item = list.find((project) => project.projectKey === projectId);
      if (item) {
        const versionNos = Array.isArray(item.versionNos) ? item.versionNos : [];
        const listedVersion = fieldAt(item.selectedVersion, "versionNo") ?? fieldAt(versionNos[0], "versionNo");
        const versionNo = this.config.project.versionNo ?? listedVersion;
        if (typeof item.ownerKey !== "string" || typeof item.projectKey !== "string" || typeof versionNo !== "string") {
          throw new BackendError("TexPage returned incomplete project identity or version data.");
        }
        const ref: ProjectRef = {
          ownerKey: item.ownerKey,
          projectKey: item.projectKey,
          versionNo,
          projectName: typeof item.projectName === "string" ? item.projectName : projectId
        };
        this.refs.set(projectId, ref);
        this.refs.set(ref.projectKey, ref);
        return ref;
      }
      if (!list.length) break;
    }
    throw new BackendError(`TexPage project not found: ${projectId}`);
  }

  private async fileTree(ref: ProjectRef): Promise<TreeFile[]> {
    const data = await this.getJson(
      `/api/project/fileTree?${new URLSearchParams({ ownerKey: ref.ownerKey, projectKey: ref.projectKey, versionNo: ref.versionNo })}`
    );
    if (!Array.isArray(data.treeData)) throw new BackendError("TexPage returned a malformed project file tree.");
    return data.treeData as TreeFile[];
  }

  private async getJson(route: string): Promise<JsonRecord> {
    const response = await this.request(route);
    const data = (await response.json()) as { status?: { code?: number; message?: string }; result?: unknown };
    if (data.status?.code !== 1)
      throw new BackendError(`TexPage API request failed: ${data.status?.message ?? "unexpected response"}`);
    if (!isRecord(data.result)) throw new BackendError("TexPage returned an empty API result.");
    return data.result;
  }

  private async request(route: string, init: FetchInit = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers)
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
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
    if (response.status < 200 || response.status >= 300)
      throw new BackendError(`TexPage request failed with HTTP ${response.status}.`);
    return response;
  }

  private requireSession(): AuthSession {
    if (!this.session) throw new BackendError("Backend is not authenticated.");
    return this.session;
  }
}

interface JoinedDocument {
  operations: OperationMetadata[];
  fileState: unknown;
  documentVersion: unknown;
}

const resolveProjectPageLimit = 20;

function rootEntity(): Entity {
  return { id: "0", name: "", type: "folder", path: "", children: [] };
}

function isBinaryEntry(file: TreeFile): boolean {
  return Boolean(file.fileType && !file.fileType.startsWith("text/"));
}

function isBinaryName(projectPath: string): boolean {
  return path.posix.extname(projectPath).toLowerCase() === ".svg";
}

function collectSiteSequences(operations: OperationMetadata[]): Record<string, number> {
  const maxSeqsBySite: Record<string, number> = {};
  for (const operation of operations) {
    const id = isRecord(operation) ? operation.spliceId : undefined;
    const site = isRecord(id) ? id.site : undefined;
    const seq = isRecord(id) ? id.seq : undefined;
    if (site === undefined || (typeof site !== "string" && typeof site !== "number") || typeof seq !== "number") {
      throw new BackendError("TexPage returned malformed CRDT operation metadata.");
    }
    maxSeqsBySite[String(site)] = Math.max(maxSeqsBySite[String(site)] ?? 0, seq);
  }
  return maxSeqsBySite;
}

async function readMutationResponse(response: HttpResponse, operation: string): Promise<JsonRecord> {
  let body: { status?: { code?: number }; result?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new BackendError(`TexPage ${operation} returned an invalid response.`);
  }
  if (body.status?.code !== 1) {
    throw new BackendError(`TexPage ${operation} failed (status: ${String(body.status?.code ?? "unknown")}).`);
  }
  return isRecord(body.result) ? body.result : {};
}

export {
  buildTextOperations,
  nextActorSequence,
  splitOperationBatches,
  validateJoinedHistory
} from "./texpage-crdt.js";
export { expectSocketEvent, isSuccessfulOperationsAck, SocketFrameQueue } from "./texpage-socket.js";
export { uploadObject } from "./texpage-upload.js";

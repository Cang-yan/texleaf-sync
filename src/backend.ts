import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";
import WebSocket from "ws";

import {
  type AuthSession,
  checkSession,
  cookieHeader,
  extractCsrfToken,
  fetchWithTimeout,
  loadSession
} from "./auth.js";
import type { TexleafConfig } from "./config.js";
import { resolveRepoPath } from "./config.js";
import { BackendError } from "./errors.js";
import { ensureDir } from "./files.js";
import { warn, Progress } from "./log.js";
import { normalizeHost } from "./platform.js";
import { normalizeProjectPath, safeExtractZip } from "./snapshot.js";

export interface Entity {
  id: string;
  name: string;
  type: "folder" | "doc" | "file";
  path: string;
  children: Entity[];
}

export class OverleafBackend {
  private session?: AuthSession;
  private csrf?: { projectId: string; token: string };
  private tree?: Entity;
  readonly host: string;

  constructor(
    private readonly repoRoot: string,
    private readonly config: TexleafConfig
  ) {
    this.host = normalizeHost(config.project.host);
  }

  async authenticate(): Promise<void> {
    const sessionFile = resolveRepoPath(this.repoRoot, this.config.auth.sessionFile);
    this.session = await loadSession(sessionFile, this.host);
    this.session = { ...this.session, sslVerify: this.config.backend.sslVerify };
    if (!this.config.backend.sslVerify) {
      warn(`TLS certificate verification is disabled for ${this.host}.`);
    }
    const status = await checkSession({
      host: this.host,
      session: this.session,
      timeoutMs: this.config.backend.timeoutMs
    });
    if (!status.loggedIn) {
      throw new BackendError(`Overleaf session is not logged in: ${status.error ?? "unknown error"}`);
    }
  }

  async projectName(projectId: string): Promise<string | undefined> {
    const response = await this.request("GET", `/project/${projectId}`, {
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    return cleanProjectTitle(await response.text());
  }

  async downloadSnapshot(projectId: string, destDir: string): Promise<void> {
    const response = await this.request("GET", `/project/${projectId}/download/zip`);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "texleaf-zip-"));
    const zipPath = path.join(tempDir, "snapshot.zip");
    const totalHeader = response.headers.get("content-length");
    const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
    const progress = new Progress("Downloading snapshot", total);
    let downloaded = 0;
    try {
      const file = fs.createWriteStream(zipPath);
      if (!response.body) throw new BackendError("Overleaf returned an empty snapshot response.");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        file.write(value);
        downloaded += value.byteLength;
        progress.update(downloaded);
      }
      await new Promise<void>((resolve, reject) => {
        file.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      progress.finish(downloaded);
      await safeExtractZip(zipPath, destDir);
    } catch (error) {
      progress.cancel();
      throw error;
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }

  async writeTextFile(projectId: string, projectPath: string, content: string): Promise<void> {
    const normalized = normalizeProjectPath(projectPath);
    const existing = await this.findEntity(projectId, normalized, true);
    if (existing?.type === "doc") {
      await this.writeTextDocViaOt(projectId, existing, content);
      return;
    }
    await this.writeFile(projectId, normalized, Buffer.from(content, "utf8"));
  }

  async uploadBinaryFile(projectId: string, projectPath: string, content: Buffer): Promise<void> {
    await this.writeFile(projectId, normalizeProjectPath(projectPath), content);
  }

  async createFolder(projectId: string, projectPath: string): Promise<Entity> {
    const normalized = normalizeProjectPath(projectPath);
    let current = await this.loadTree(projectId);
    if (!normalized) return current;
    for (const part of normalized.split("/")) {
      let found = current.children.find((child) => child.name === part && child.type === "folder");
      if (!found) {
        const response = await this.request("POST", `/project/${projectId}/folder`, {
          csrfProjectId: projectId,
          json: { parent_folder_id: current.id, name: part }
        });
        found = this.entityFromResponse(await response.json(), current.path);
        current.children.push(found);
      }
      current = found;
    }
    return current;
  }

  async deletePath(projectId: string, projectPath: string): Promise<void> {
    const entity = await this.findEntity(projectId, projectPath, true);
    if (!entity) return;
    await this.request("DELETE", `/project/${projectId}/${entity.type}/${entity.id}`, {
      csrfProjectId: projectId,
      json: {}
    });
    this.tree = undefined;
  }

  async movePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    const entity = await this.findEntity(projectId, oldPath, true);
    if (!entity) throw new BackendError(`Cannot move missing remote path: ${oldPath}`);
    const normalized = normalizeProjectPath(newPath);
    const parentPath = path.posix.dirname(normalized);
    const parent = await this.createFolder(projectId, parentPath === "." ? "" : parentPath);
    const newName = path.posix.basename(normalized);
    if (entity.name !== newName) {
      await this.request("POST", `/project/${projectId}/${entity.type}/${entity.id}/rename`, {
        csrfProjectId: projectId,
        json: { name: newName, source: "editor" }
      });
    }
    const oldParent = path.posix.dirname(entity.path);
    const nextParent = path.posix.dirname(normalized);
    if (oldParent !== nextParent) {
      await this.request("POST", `/project/${projectId}/${entity.type}/${entity.id}/move`, {
        csrfProjectId: projectId,
        json: { folder_id: parent.id, source: "editor" }
      });
    }
    this.tree = undefined;
  }

  private async writeFile(projectId: string, projectPath: string, content: Buffer): Promise<void> {
    const parentPath = path.posix.dirname(projectPath);
    const fileName = path.posix.basename(projectPath);
    const parent = await this.createFolder(projectId, parentPath === "." ? "" : parentPath);
    const existing = await this.findEntity(projectId, projectPath);
    if (!existing) {
      await this.uploadNewFile(projectId, parent.id, parent.path, fileName, content);
      this.tree = undefined;
      return;
    }
    if (existing.type === "folder") throw new BackendError(`Cannot replace folder with file: ${projectPath}`);

    const stamp = Date.now();
    const tempName = `.texleaf-upload-${stamp}-${fileName}`;
    const backupName = `.texleaf-backup-${stamp}-${fileName}`;
    const temp = await this.uploadNewFile(projectId, parent.id, parent.path, tempName, content);
    await this.request("POST", `/project/${projectId}/${existing.type}/${existing.id}/rename`, {
      csrfProjectId: projectId,
      json: { name: backupName, source: "editor" }
    });
    await this.request("POST", `/project/${projectId}/${temp.type}/${temp.id}/rename`, {
      csrfProjectId: projectId,
      json: { name: fileName, source: "editor" }
    });
    await this.request("DELETE", `/project/${projectId}/${existing.type}/${existing.id}`, {
      csrfProjectId: projectId,
      json: {}
    });
    this.tree = undefined;
  }

  private async uploadNewFile(
    projectId: string,
    folderId: string,
    parentPath: string,
    fileName: string,
    content: Buffer
  ): Promise<Entity> {
    const form = new FormData();
    form.append("relativePath", "null");
    form.append("name", fileName);
    form.append("type", "application/octet-stream");
    form.append("qqfile", new Blob([new Uint8Array(content)], { type: "application/octet-stream" }), fileName);
    const response = await this.request("POST", `/Project/${projectId}/upload?${new URLSearchParams({ folder_id: folderId })}`, {
      csrfProjectId: projectId,
      body: form
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!data.success || typeof data.entity_id !== "string" || (data.entity_type !== "doc" && data.entity_type !== "file")) {
      throw new BackendError(`Overleaf upload failed for ${fileName}: ${JSON.stringify(data)}`);
    }
    return {
      id: data.entity_id,
      name: fileName,
      type: data.entity_type,
      path: joinProjectPath(parentPath, fileName),
      children: []
    };
  }

  private async writeTextDocViaOt(projectId: string, entity: Entity, content: string): Promise<void> {
    const { socket } = await this.openJoinedSocket(projectId);
    try {
      const joined = await this.socketRpc(socket, 1, "joinDoc", [
        entity.id,
        { encodeRanges: true, supportsHistoryOT: true }
      ]);
      if (joined.length < 3 || joined[0] !== null) throw new BackendError(`Overleaf rejected joinDoc for ${entity.path}.`);
      const lines = joined[1];
      const version = joined[2];
      const otType = joined.length > 5 ? joined[5] : "sharejs-text-ot";
      if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
        throw new BackendError("Overleaf joinDoc returned malformed document lines.");
      }
      if (typeof version !== "number") throw new BackendError("Overleaf joinDoc returned an invalid document version.");
      if (otType !== "sharejs-text-ot") throw new BackendError(`Unsupported Overleaf text OT type: ${String(otType)}`);
      const current = lines.map((line) => decodeOverleafLine(line)).join("\n");
      const op = textReplacementOperation(current, content);
      if (!op.length) return;
      for (const component of op) {
        if (component.i && [...component.i].some((char) => (char.codePointAt(0) ?? 0) > 0xffff)) {
          throw new BackendError(`Cannot safely insert non-BMP Unicode characters into ${entity.path}.`);
        }
      }
      const applied = await this.socketRpc(socket, 2, "applyOtUpdate", [entity.id, { v: version, op }]);
      if (applied.length && applied[0] !== null) throw new BackendError(`Overleaf rejected text update for ${entity.path}.`);
      await this.waitForTextContent(projectId, entity, content);
    } finally {
      socket.close();
      this.tree = undefined;
    }
  }

  private async waitForTextContent(projectId: string, entity: Entity, expected: string): Promise<void> {
    const deadline = Date.now() + this.config.backend.timeoutMs;
    while (Date.now() <= deadline) {
      const response = await this.request("GET", `/Project/${projectId}/doc/${entity.id}/download`);
      if ((await response.text()) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new BackendError(`Text update for ${entity.path} was acknowledged but did not converge.`);
  }

  private async loadTree(projectId: string, refresh = false): Promise<Entity> {
    if (this.tree && !refresh) return this.tree;
    const { socket, event } = await this.openJoinedSocket(projectId);
    try {
      const rootFolders = event.args?.[0]?.project?.rootFolder;
      if (!Array.isArray(rootFolders) || rootFolders.length !== 1) {
        throw new BackendError("Malformed Overleaf project tree response.");
      }
      this.tree = entityFromSocketFolder(rootFolders[0], "");
      return this.tree;
    } finally {
      socket.close();
    }
  }

  private async findEntity(projectId: string, projectPath: string, refresh = false): Promise<Entity | undefined> {
    const normalized = normalizeProjectPath(projectPath);
    const root = await this.loadTree(projectId, refresh);
    if (!normalized) return root;
    return flatten(root).find((entity) => entity.path === normalized);
  }

  private async openJoinedSocket(projectId: string): Promise<{ socket: WebSocket; event: Record<string, any> }> {
    const socket = await this.openSocket(projectId);
    try {
      const event = await this.receiveSocketEvent(socket, "joinProjectResponse");
      return { socket, event };
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  private async openSocket(projectId: string): Promise<WebSocket> {
    const session = this.requireSession();
    const t = String(Date.now());
    const handshake = await fetchWithTimeout(`${this.host}/socket.io/1/?${new URLSearchParams({ projectId, t })}`, {
      headers: { Cookie: cookieHeader(session) },
      redirect: "manual",
      timeoutMs: this.config.backend.timeoutMs,
      sslVerify: this.config.backend.sslVerify
    });
    if (handshake.status >= 300) throw new BackendError(`Could not open Overleaf socket: HTTP ${handshake.status}`);
    const socketId = (await handshake.text()).split(":", 1)[0];
    const parsed = new URL(this.host);
    const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}/socket.io/1/websocket/${socketId}?${new URLSearchParams({ projectId })}`;
    const socket = new WebSocket(url, {
      headers: { Cookie: cookieHeader(session) },
      rejectUnauthorized: this.config.backend.sslVerify
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return socket;
  }

  private async socketRpc(socket: WebSocket, ackId: number, eventName: string, args: unknown[]): Promise<unknown[]> {
    socket.send(`5:${ackId}+::${JSON.stringify({ name: eventName, args })}`);
    const ackPrefix = `6:::${ackId}`;
    while (true) {
      const line = await this.receiveSocketLine(socket);
      if (line.startsWith("7:")) throw new BackendError(`Overleaf socket rejected ${eventName}.`);
      if (line === ackPrefix) return [];
      if (!line.startsWith(`${ackPrefix}+`)) continue;
      const payload = line.slice(ackPrefix.length + 1);
      if (!payload) return [];
      const parsed = JSON.parse(payload) as unknown;
      if (!Array.isArray(parsed)) throw new BackendError(`Malformed Overleaf acknowledgement for ${eventName}.`);
      return parsed;
    }
  }

  private async receiveSocketEvent(socket: WebSocket, eventName: string): Promise<Record<string, any>> {
    while (true) {
      const line = await this.receiveSocketLine(socket);
      if (line.startsWith("7:")) throw new BackendError("Overleaf socket rejected project access.");
      const event = parseSocketEvent(line);
      if (event?.name === eventName) return event;
    }
  }

  private async receiveSocketLine(socket: WebSocket): Promise<string> {
    while (true) {
      const line = await nextSocketMessage(socket);
      if (line.startsWith("2::")) {
        socket.send("2::");
        continue;
      }
      return line;
    }
  }

  private async request(
    method: string,
    route: string,
    options: {
      headers?: Record<string, string>;
      csrfProjectId?: string;
      json?: unknown;
      body?: BodyInit;
    } = {}
  ): Promise<Response> {
    const session = this.requireSession();
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      Cookie: cookieHeader(session),
      Referer: `${this.host}/project/${options.csrfProjectId ?? this.config.project.projectId}`,
      ...options.headers
    };
    let body = options.body;
    if (options.csrfProjectId) headers["x-csrf-token"] = await this.csrfToken(options.csrfProjectId);
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const response = await fetchWithTimeout(`${this.host}${route}`, {
      method,
      headers,
      body,
      redirect: "manual",
      timeoutMs: this.config.backend.timeoutMs,
      sslVerify: this.config.backend.sslVerify
    });
    if (response.status >= 300 && response.status < 400) {
      throw new BackendError(`Overleaf HTTP ${method} ${route} redirected unexpectedly.`);
    }
    if (response.status >= 400) {
      throw new BackendError(`Overleaf HTTP ${method} ${route} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return response;
  }

  private async csrfToken(projectId: string): Promise<string> {
    if (this.csrf?.projectId === projectId) return this.csrf.token;
    const response = await this.request("GET", `/project/${projectId}`);
    this.csrf = { projectId, token: extractCsrfToken(await response.text()) };
    return this.csrf.token;
  }

  private requireSession(): AuthSession {
    if (!this.session) throw new BackendError("Backend is not authenticated.");
    return this.session;
  }

  private entityFromResponse(data: unknown, parentPath: string): Entity {
    const record = data as Record<string, unknown>;
    if (typeof record._id !== "string" || typeof record.name !== "string") {
      throw new BackendError("Overleaf returned a malformed entity response.");
    }
    const type = record.type === "doc" || record.type === "file" ? record.type : "folder";
    return { id: record._id, name: record.name, type, path: joinProjectPath(parentPath, record.name), children: [] };
  }
}

export function cleanProjectTitle(htmlOrTitle: string): string | undefined {
  const title = htmlOrTitle.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? htmlOrTitle;
  let cleaned = title.replace(/\s+/g, " ").trim();
  if (cleaned.endsWith(", Online LaTeX Editor") && cleaned.includes(" - ")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf(" - ")).trim();
  }
  for (const suffix of [" - Overleaf, Online LaTeX Editor", " - Overleaf", " | Overleaf"]) {
    if (cleaned.endsWith(suffix)) cleaned = cleaned.slice(0, -suffix.length).trim();
  }
  return cleaned || undefined;
}

export interface TextOp {
  p: number;
  d?: string;
  i?: string;
}

export function textReplacementOperation(oldText: string, newText: string): TextOp[] {
  if (oldText === newText) return [];
  let prefix = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  const oldRemaining = oldText.length - prefix;
  const newRemaining = newText.length - prefix;
  while (
    suffix < oldRemaining &&
    suffix < newRemaining &&
    oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
  ) {
    suffix++;
  }
  const oldEnd = suffix ? oldText.length - suffix : oldText.length;
  const newEnd = suffix ? newText.length - suffix : newText.length;
  const deleted = oldText.slice(prefix, oldEnd);
  const inserted = newText.slice(prefix, newEnd);
  const op: TextOp[] = [];
  if (deleted) op.push({ d: deleted, p: prefix });
  if (inserted) op.push({ i: inserted, p: prefix });
  return op;
}

function decodeOverleafLine(line: string): string {
  if ([...line].some((char) => (char.codePointAt(0) ?? 0) > 255)) return line;
  return Buffer.from([...line].map((char) => char.charCodeAt(0))).toString("utf8");
}

function entityFromSocketFolder(data: Record<string, any>, parentPath: string): Entity {
  const name = String(data.name);
  const folderPath = !parentPath && name === "rootFolder" ? "" : joinProjectPath(parentPath, name);
  const folder: Entity = { id: String(data._id), name, type: "folder", path: folderPath, children: [] };
  for (const child of data.folders ?? []) folder.children.push(entityFromSocketFolder(child, folderPath));
  for (const child of data.fileRefs ?? []) {
    folder.children.push({
      id: String(child._id),
      name: String(child.name),
      type: "file",
      path: joinProjectPath(folderPath, String(child.name)),
      children: []
    });
  }
  for (const child of data.docs ?? []) {
    folder.children.push({
      id: String(child._id),
      name: String(child.name),
      type: "doc",
      path: joinProjectPath(folderPath, String(child.name)),
      children: []
    });
  }
  return folder;
}

function flatten(root: Entity): Entity[] {
  return root.children.flatMap((child) => (child.type === "folder" ? [child, ...flatten(child)] : [child]));
}

function joinProjectPath(parent: string, name: string): string {
  return normalizeProjectPath(parent ? `${parent}/${name}` : name);
}

function parseSocketEvent(line: string): Record<string, any> | undefined {
  if (!line.startsWith("5:")) return undefined;
  return JSON.parse(line.slice(2).replace(/^:+/, "")) as Record<string, any>;
}

async function nextSocketMessage(socket: WebSocket): Promise<string> {
  return await new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => cleanup(() => resolve(data.toString("utf8")));
    const onError = (error: Error) => cleanup(() => reject(error));
    const onClose = () => cleanup(() => reject(new BackendError("Overleaf socket closed unexpectedly.")));
    const cleanup = (next: () => void) => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      next();
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

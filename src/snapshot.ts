import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

import { TexleafError } from "./errors.js";
import { ensureDir } from "./files.js";

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open zip file"));
      else resolve(zip);
    });
  });
}

export interface TreeDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function normalizeProjectPath(input: string): string {
  const replaced = input.replaceAll("\\", "/");
  if (replaced.startsWith("/") || /^[A-Za-z]:\//.test(replaced)) {
    throw new TexleafError(`Refusing absolute project path: ${input}`);
  }
  const parts: string[] = [];
  for (const part of replaced.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new TexleafError(`Refusing path traversal: ${input}`);
    parts.push(part);
  }
  return parts.join("/");
}

export function isIgnored(projectPath: string, patterns: string[]): boolean {
  const normalized = normalizeProjectPath(projectPath);
  for (const pattern of patterns) {
    const pat = pattern.trim();
    if (!pat) continue;
    if (pat.endsWith("/")) {
      const prefix = pat.slice(0, -1);
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
      continue;
    }
    if (globMatch(normalized, pat) || globMatch(path.posix.basename(normalized), pat)) {
      return true;
    }
  }
  return false;
}

export async function safeExtractZip(zipPath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  const zip = await openZip(zipPath);
  const seen = new Map<string, string>();

  await new Promise<void>((resolve, reject) => {
    zip.readEntry();
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const normalized = normalizeProjectPath(entry.fileName);
          if (!normalized) {
            zip.readEntry();
            return;
          }
          const collisionKey = normalized.normalize("NFC").toLocaleLowerCase();
          const previous = seen.get(collisionKey);
          if (previous && previous !== normalized) {
            throw new TexleafError(`Snapshot contains colliding paths: ${previous} and ${normalized}`);
          }
          seen.set(collisionKey, normalized);

          const target = path.join(destDir, normalized);
          if (/\/$/.test(entry.fileName)) {
            await ensureDir(target);
            zip.readEntry();
            return;
          }
          await ensureDir(path.dirname(target));
          const stream = await new Promise<NodeJS.ReadableStream>((streamResolve, streamReject) => {
            zip.openReadStream(entry, (error, readStream) => {
              if (error || !readStream) streamReject(error ?? new Error("Missing zip stream"));
              else streamResolve(readStream);
            });
          });
          await new Promise<void>((streamResolve, streamReject) => {
            stream
              .pipe(fs.createWriteStream(target, { mode: 0o644 }))
              .on("finish", streamResolve)
              .on("error", streamReject);
          });
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      })();
    });
    zip.on("end", () => resolve());
    zip.on("error", reject);
  });
}

export async function collectTree(root: string, patterns: string[]): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return files;
  for await (const file of walk(root)) {
    const rel = normalizeProjectPath(path.relative(root, file));
    if (isIgnored(rel, patterns)) continue;
    files.set(rel, await fsp.readFile(file));
  }
  return files;
}

export async function collectTreeHashes(root: string, patterns: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!fs.existsSync(root)) return files;
  for await (const file of walk(root)) {
    const rel = normalizeProjectPath(path.relative(root, file));
    if (isIgnored(rel, patterns)) continue;
    files.set(rel, await fileSha256(file));
  }
  return files;
}

export async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function compareTrees(expected: Map<string, string>, actual: Map<string, string>): TreeDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const pathName of actual.keys()) {
    if (!expected.has(pathName)) added.push(pathName);
    else if (expected.get(pathName) !== actual.get(pathName)) modified.push(pathName);
  }
  for (const pathName of expected.keys()) {
    if (!actual.has(pathName)) deleted.push(pathName);
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort()
  };
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // "**/" spans zero or more directories (gitignore semantics), "**" matches
  // anything including slashes, and a single "*" stops at a directory boundary.
  const regex = escaped
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", ".")
    .replaceAll("\u0001", ".*")
    .replaceAll("\u0000", "(?:.*/)?");
  return new RegExp(`^${regex}$`).test(value);
}

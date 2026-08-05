import fs from "node:fs/promises";
import path from "node:path";

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJsonAtomic(target: string, value: unknown, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(target));
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.rename(temp, target);
  await fs.chmod(target, mode);
}

export async function readJson<T>(target: string): Promise<T> {
  return JSON.parse(await fs.readFile(target, "utf8")) as T;
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isEmptyDirectory(target: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(target);
    return entries.length === 0;
  } catch {
    return true;
  }
}

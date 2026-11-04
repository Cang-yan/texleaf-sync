// Narrowing helpers shared by the socket-facing modules, so payload handling
// does not fall back to `any`.
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fieldAt(container: unknown, key: string | number): unknown {
  if (typeof key === "number") return Array.isArray(container) ? container[key] : undefined;
  return isRecord(container) ? container[key] : undefined;
}

export function recordAt(container: unknown, key: string | number): JsonRecord | undefined {
  const entry = fieldAt(container, key);
  return isRecord(entry) ? entry : undefined;
}

export function statusCodeOf(payload: JsonRecord): number | undefined {
  const status = payload.status;
  return isRecord(status) && typeof status.code === "number" ? status.code : undefined;
}

export function statusMessageOf(payload: JsonRecord): string | undefined {
  const status = payload.status;
  return isRecord(status) && typeof status.message === "string" ? status.message : undefined;
}

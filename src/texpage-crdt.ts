import { BackendError } from "./errors.js";

// TexPage documents are a CRDT of splice operations. Positions are row/column
// pairs and identifiers carry the site (account key) plus a per-site sequence.
export interface SpliceId {
  site: string | number;
  seq: number;
}

export interface TextPosition {
  row: number;
  column: number;
}

export interface TextOperation {
  type: "splice";
  spliceId: SpliceId;
  deletion?: {
    spliceId: SpliceId;
    leftDependencyId: SpliceId;
    offsetInLeftDependency: TextPosition;
    rightDependencyId: SpliceId;
    offsetInRightDependency: TextPosition;
    maxSeqsBySite: Record<string, number>;
  };
  insertion?: {
    text: string;
    leftDependencyId: SpliceId;
    offsetInLeftDependency: TextPosition;
    rightDependencyId: SpliceId;
    offsetInRightDependency: TextPosition;
  };
}

export interface TextOperationEnvelope {
  fileKey: string;
  versionNo: string;
  operation: TextOperation;
}

/** Characters per insertion splice; large documents go out as several splices. */
export const insertChunkUnits = 200;

/** Splices per operations message. */
export const operationBatchSize = 100;

/** Wire metadata of an already applied operation, used to allocate sequences. */
export interface OperationMetadata {
  spliceId?: { site?: unknown; seq?: unknown };
}

export function buildTextOperations(
  text: string,
  fileKey: string,
  versionNo: string,
  site: string,
  firstSeq: number,
  maxSeqsBySite: Record<string, number>
): TextOperationEnvelope[] {
  const chunks = splitText(text, insertChunkUnits);
  const out: TextOperationEnvelope[] = [];
  const count = Math.max(1, chunks.length);
  for (let index = 0; index < count; index++) {
    const spliceId: SpliceId = { site, seq: firstSeq + index };
    const operation: TextOperation = { type: "splice", spliceId };
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
    const chunk = chunks[index];
    if (chunk !== undefined) {
      operation.insertion = {
        text: chunk,
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

export function nextActorSequence(site: string, operations: OperationMetadata[]): number {
  // Sites arrive as strings or numbers depending on the writer; compare them
  // the same way maxSeqsBySite keys them so no sequence is reused.
  const target = String(site);
  let max = 0;
  for (const item of operations) {
    const id = item.spliceId;
    if (id && String(id.site) === target && typeof id.seq === "number") max = Math.max(max, id.seq);
  }
  return max + 1;
}

export function splitOperationBatches<T>(operations: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("Operation batch size must be a positive integer.");
  const batches: T[][] = [];
  for (let offset = 0; offset < operations.length; offset += batchSize)
    batches.push(operations.slice(offset, offset + batchSize));
  return batches;
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

function splitText(value: string, maxUnits: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maxUnits, value.length);
    if (end < value.length && end > start) {
      // Never split a surrogate pair across two splices.
      const prev = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function extent(value: string): TextPosition {
  const parts = value.split("\n");
  return { row: parts.length - 1, column: parts[parts.length - 1].length };
}

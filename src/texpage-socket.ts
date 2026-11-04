import WebSocket from "ws";

import { BackendError } from "./errors.js";
import { isRecord, statusCodeOf } from "./json.js";

// Engine.IO frame handling for TexPage's realtime channel: the queue buffers
// frames so an acknowledgement wait cannot lose unrelated events.
export class SocketFrameQueue {
  private frames: string[] = [];
  private waiters: Array<{ resolve: (frame: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> =
    [];
  private failure?: Error;

  constructor(
    private readonly socket: WebSocket,
    private readonly deadline: number
  ) {
    socket.on("message", (data: WebSocket.RawData) => {
      const frame = data.toString("utf8");
      if (frame === pingFrame) {
        if (socket.readyState === WebSocket.OPEN) socket.send(pongFrame);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else this.frames.push(frame);
    });
    socket.on("error", (error: Error) =>
      this.fail(new BackendError(`TexPage realtime connection failed: ${error.message}`))
    );
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
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

const pingFrame = "2";
const pongFrame = "3";

export function socketEvent(name: string, payload: unknown, ackId?: number): string {
  return `42${ackId ?? ""}${JSON.stringify([name, payload])}`;
}

export async function waitSocketOpen(socket: WebSocket, deadline: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new BackendError("TexPage realtime connection timed out."))),
      Math.max(0, deadline - Date.now())
    );
    const onOpen = () => finish(resolve);
    const onError = () => finish(() => reject(new BackendError("TexPage realtime connection failed.")));
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      complete();
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

export async function expectSocketFrame(frames: SocketFrameQueue, accept: (frame: string) => boolean): Promise<string> {
  while (true) {
    const frame = await frames.next();
    if (accept(frame)) return frame;
  }
}

export async function expectSocketEvent(
  frames: SocketFrameQueue,
  accept: (name: string, payload: unknown) => boolean
): Promise<unknown> {
  while (true) {
    const frame = await frames.next();
    if (!frame.startsWith(eventFramePrefix)) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.slice(eventFramePrefix.length));
    } catch {
      continue;
    }
    if (!Array.isArray(decoded) || typeof decoded[0] !== "string") continue;
    const [name, payload] = decoded;
    if (process.env.TEXLEAF_TEXPAGE_TRACE === "1") {
      console.error(`[texpage trace] event=${name} ${describePayload(payload)}`);
    }
    if (accept(name, payload)) return payload;
  }
}

const eventFramePrefix = "42";

export function isSuccessfulOperationsAck(frame: string, ackId: number, batchId: string): boolean {
  const packet = /^43(\d+)([\s\S]*)$/.exec(frame);
  if (!packet || Number(packet[1]) !== ackId) return false;
  const args = packet[2];
  if (!args.startsWith("[")) {
    throw new BackendError("TexPage returned a malformed operations callback.");
  }
  let callback: unknown;
  try {
    callback = JSON.parse(args);
  } catch {
    throw new BackendError("TexPage returned a malformed operations callback.");
  }
  const ack = Array.isArray(callback) && isRecord(callback[0]) ? callback[0] : undefined;
  if (!ack || ack.batchId !== batchId || ack.status !== "ok") {
    const status = ack && typeof ack.status === "string" ? ack.status : "unknown";
    throw new BackendError(`TexPage rejected document operations (status: ${status}).`);
  }
  return true;
}

function describePayload(payload: unknown): string {
  if (!isRecord(payload)) return typeof payload;
  const keys = Object.keys(payload).sort().join(",");
  const nested = isRecord(payload.data) ? Object.keys(payload.data).sort().join(",") : "-";
  const result = isRecord(payload.result) ? Object.keys(payload.result).sort().join(",") : "-";
  const action = typeof payload.action === "string" ? payload.action : "-";
  return `status=${statusCodeOf(payload) ?? "-"} action=${action} keys=${keys} dataKeys=${nested} resultKeys=${result}`;
}

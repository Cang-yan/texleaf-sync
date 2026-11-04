import assert from "node:assert/strict";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

import { expectSocketEvent, isSuccessfulOperationsAck, SocketFrameQueue } from "../dist/texpage-backend.js";

test("operations ACK parser requires matching batch ID and ok status", () => {
  assert.equal(isSuccessfulOperationsAck('431[{"batchId":"batch","status":"ok"}]', 1, "batch"), true);
  assert.equal(isSuccessfulOperationsAck('432[{"batchId":"batch","status":"ok"}]', 1, "batch"), false);
  assert.equal(isSuccessfulOperationsAck('4310[{"batchId":"batch","status":"ok"}]', 1, "batch"), false);
  assert.equal(isSuccessfulOperationsAck('4310[{"batchId":"batch","status":"ok"}]', 10, "batch"), true);
  assert.throws(() => isSuccessfulOperationsAck('431[{"batchId":"other","status":"ok"}]', 1, "batch"), /status: ok/);
  assert.throws(
    () => isSuccessfulOperationsAck('431[{"batchId":"batch","status":"invalid_payload"}]', 1, "batch"),
    /status: invalid_payload/
  );
});

async function makeSocketPair(t, onConnection) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on("connection", onConnection);
  const deadline = Date.now() + 2_000;
  const queue = new SocketFrameQueue(client, deadline);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return { client, queue };
}

test("SocketFrameQueue buffers handshake and multiple acknowledgement frames", async (t) => {
  const pair = await makeSocketPair(t, (socket) => {
    socket.once("message", () => {
      socket.send("40{}");
      socket.send('42["joinedDoc",{"data":{"operations":[]}}]');
      socket.send('431[{"batchId":"batch","status":"ok"}]');
      socket.send('42["mergedOperations",["file.1.splice"]]');
      socket.send('42["mergedOperations",["file.2.splice"]]');
    });
  });
  pair.client.send("40");

  assert.equal(await pair.queue.next(), "40{}");
  const joined = await expectSocketEvent(pair.queue, (name) => name === "joinedDoc");
  assert.deepEqual(joined.data.operations, []);
  assert.equal(await pair.queue.next(), '431[{"batchId":"batch","status":"ok"}]');
  const firstAck = await expectSocketEvent(pair.queue, (name) => name === "mergedOperations");
  const secondAck = await expectSocketEvent(pair.queue, (name) => name === "mergedOperations");
  assert.deepEqual(firstAck, ["file.1.splice"]);
  assert.deepEqual(secondAck, ["file.2.splice"]);
});

test("SocketFrameQueue rejects a waiter when the server closes early", async (t) => {
  const pair = await makeSocketPair(t, (socket) => {
    socket.once("message", () => socket.close());
  });
  pair.client.send("40");
  await assert.rejects(pair.queue.next(), /closed unexpectedly/);
});

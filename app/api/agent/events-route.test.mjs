import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 流语义已抽到 lib/agent/session-events；两个宿主共用同一实现。
const route = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const shared = await readFile(new URL("../../../lib/agent/session-events.ts", import.meta.url), "utf8");

test("the SSE route delegates stream semantics to the shared module", () => {
  assert.match(route, /openSessionEventStream\(/);
  assert.match(route, /parseLastEventId\(req\.headers\.get\("last-event-id"\)\)/);
  // 路由不再自带一套快照/缓冲逻辑，避免两套实现漂移。
  assert.doesNotMatch(route, /snapshotState|isEventIncludedInSnapshot|toClientAgentEvent/);
});

test("the shared stream subscribes before reading the snapshot", () => {
  const subscribeAt = shared.indexOf("session.onEvent(");
  const snapshotAt = shared.indexOf("snapshotState.message = session.streamingMessage");
  assert.ok(subscribeAt !== -1 && snapshotAt !== -1, "both steps must exist");
  assert.ok(subscribeAt < snapshotAt, "subscription must precede the snapshot");
});

test("the shared stream publishes connected before the snapshot message and dedupes it", () => {
  const connectedAt = shared.indexOf('type: "connected"');
  const messageStartAt = shared.indexOf('type: "message_start"');
  assert.ok(connectedAt !== -1 && messageStartAt !== -1);
  assert.ok(connectedAt < messageStartAt);
  assert.match(shared, /if \(!snapshotState\.published\)/);
  assert.match(shared, /isEventIncludedInSnapshot\(event, snapshotState\.message\)/);
});

test("the shared stream projects SDK events and numbers them", () => {
  assert.match(shared, /toClientAgentEvent\(event\)/);
  assert.match(shared, /if \(clientEvent\) send\(/);
  assert.match(shared, /seq: \+\+seq/);
});

test("the shared stream releases its subscription on close", () => {
  assert.match(shared, /unsubscribe\(\)/);
  assert.match(shared, /clearInterval\(heartbeat\)/);
});

test("the SSE route releases the subscription when the client disconnects", () => {
  assert.match(route, /req\.signal\?\.addEventListener\("abort", close/);
  assert.match(route, /events\.close\(\)/);
});

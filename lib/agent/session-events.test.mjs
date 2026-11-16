import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { openSessionEventStream, parseLastEventId } = await jiti.import("./session-events.ts");

function source({ sessionId = "s1", isStreaming = true, snapshot } = {}) {
  const listeners = new Set();
  return {
    sessionId,
    isStreaming,
    streamingMessage: snapshot,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event) {
      for (const listener of [...listeners]) listener(event);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function collect(session, options) {
  const events = [];
  const stream = openSessionEventStream(session, (event) => events.push(event), { heartbeatMs: 0, ...options });
  return { events, stream };
}

test("subscribes before the snapshot and emits connected first", () => {
  const session = source();
  const { events } = collect(session);
  assert.equal(events[0].type, "connected");
  assert.equal(events[0].sessionId, "s1");
  assert.equal(events[0].isStreaming, true);
  assert.equal(events[0].resync, false);
  assert.equal(events[0].seq, 1);
});

test("the snapshot message is sent once and its own deltas are not duplicated", () => {
  const snapshot = { role: "assistant", content: [] };
  const session = source({ snapshot });
  const { events } = collect(session);

  assert.equal(events[1].type, "message_start");
  assert.equal(events[1].message, snapshot);

  // 快照推送期间到达的事件被缓冲，快照包含的同一对象不再重复发送。
  session.publish({ type: "message_update", message: snapshot, assistantMessageEvent: { type: "text_delta", delta: "a" } });
  session.publish({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "b" } });

  const deltas = events.filter((event) => event.type === "message_update");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].assistantMessageEvent.delta, "b");
});

test("events arriving while publishing are buffered, then delivered in order", () => {
  const session = source();
  const seen = [];
  // 在 emit 回调里发布事件，模拟“快照发布期间”的并发写入。
  const stream = openSessionEventStream(session, (event) => {
    seen.push(event.type);
    if (event.type === "connected") session.publish({ type: "message_start", message: { role: "assistant" } });
  }, { heartbeatMs: 0 });
  try {
    assert.deepEqual(seen, ["connected", "message_start"]);
  } finally {
    stream.close();
  }
});

test("sequence numbers increase monotonically and start from the given base", () => {
  const session = source();
  const { events, stream } = collect(session, { startSeq: 10 });
  session.publish({ type: "agent_end" });
  const sequence = events.map((event) => event.seq);
  assert.deepEqual(sequence, sequence.slice().sort((a, b) => a - b));
  assert.equal(sequence[0], 11);
  assert.equal(stream.seq, sequence.at(-1));
});

test("reconnect signals resync instead of pretending the stream continued", () => {
  const session = source();
  const { events } = collect(session, { lastEventId: 4 });
  assert.equal(events[0].resync, true);
});

test("noise events stay filtered out of the client stream", () => {
  const session = source();
  const { events } = collect(session);
  session.publish({ type: "turn_start" });
  session.publish({ type: "tool_execution_update" });
  session.publish({ type: "message_end", message: { role: "user", content: "hi" } });
  assert.deepEqual(events.map((event) => event.type), ["connected", "message_end"]);
});

test("closing releases the subscription once and stops emitting", () => {
  const session = source();
  const { events, stream } = collect(session);
  assert.equal(session.listenerCount, 1);
  stream.close();
  stream.close();
  assert.equal(session.listenerCount, 0);
  const before = events.length;
  session.publish({ type: "agent_end" });
  assert.equal(events.length, before);
});

test("heartbeat fires on an interval and stops after close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const session = source();
  let ticks = 0;
  const stream = openSessionEventStream(session, () => {}, { heartbeatMs: 1000, onHeartbeat: () => { ticks += 1; } });
  t.mock.timers.tick(3000);
  assert.equal(ticks, 3);
  stream.close();
  t.mock.timers.tick(3000);
  assert.equal(ticks, 3);
});

test("Last-Event-ID parsing ignores malformed values", () => {
  assert.equal(parseLastEventId("7"), 7);
  assert.equal(parseLastEventId("0"), 0);
  for (const value of [null, undefined, "", "-1", "1.5", "abc"]) {
    assert.equal(parseLastEventId(value), undefined);
  }
});

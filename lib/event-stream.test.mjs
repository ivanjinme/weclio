import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createEventStream } = await jiti.import("./event-stream.ts");
const { setAgentCredential, resetAgentCredential } = await jiti.import("./agent-credential.ts");

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function settle(fn, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not met");
}

test("event stream carries frames, ids and ignores heartbeats", async (t) => {
  resetAgentCredential();
  setAgentCredential("tok-123");
  t.after(() => resetAgentCredential());

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) });
    return new Response(
      streamOf([
        ":\n\n",
        'data: {"type":"connected"}\nid: 1\n\n',
        'data: {"type":"message_start"}\nid: 2\n\n',
        "data: partial",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  const stream = createEventStream("http://127.0.0.1:9/v1/sessions/s1/events?cwd=%2Fw", {
    fetchImpl,
    lastEventId: "7",
  });
  const seen = [];
  stream.onmessage = (event) => seen.push(event);

  await settle(() => seen.length === 2);
  assert.deepEqual(seen.map((event) => event.data), ['{"type":"connected"}', '{"type":"message_start"}']);
  assert.deepEqual(seen.map((event) => event.lastEventId), ["1", "2"]);
  assert.equal(requests[0].headers.get("authorization"), "Bearer tok-123");
  assert.equal(requests[0].headers.get("accept"), "text/event-stream");
  assert.equal(requests[0].headers.get("last-event-id"), "7");
  stream.close();
});

test("event stream reports failure on a non-2xx response and on unexpected close", async () => {
  const unauthorized = createEventStream("http://127.0.0.1:9/v1/events", {
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  const unauthorizedErrors = [];
  unauthorized.onerror = (error) => unauthorizedErrors.push(error);
  await settle(() => unauthorizedErrors.length === 1);
  assert.equal(unauthorizedErrors[0].status, 401);
  assert.equal(unauthorized.readyState, 2);

  const closed = createEventStream("http://127.0.0.1:9/v1/events", {
    fetchImpl: async () => new Response(streamOf(['data: {"type":"running"}\n\n']), { status: 200 }),
  });
  const closedErrors = [];
  closed.onerror = (error) => closedErrors.push(error);
  await settle(() => closedErrors.length === 1);
  // 正常结束也要通知调用方，否则断线重连永远不会触发。
  assert.deepEqual(closedErrors[0], { readyState: 2 });
});

test("closing the stream aborts without reporting an error", async () => {
  let aborted = false;
  const stream = createEventStream("http://127.0.0.1:9/v1/events", {
    fetchImpl: async (_url, init) => {
      await new Promise((resolve) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  const errors = [];
  stream.onerror = (error) => errors.push(error);
  stream.close();
  await settle(() => aborted);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(errors, []);
  assert.equal(stream.readyState, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createEventStream } = await jiti.import("./event-stream.ts");
const { setAgentCredential, resetAgentCredential } = await jiti.import("./agent-credential.ts");
const { configureApiBase, resetApiBase } = await jiti.import("./api-base.ts");

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
  configureApiBase({ baseUrl: "http://127.0.0.1:9", basePath: "/v1" });
  t.after(() => { resetAgentCredential(); resetApiBase(); });

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

test("event stream terminates on unauthorized but reconnects on unexpected close", async (t) => {
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
  t.after(() => closed.close());
  const closedErrors = [];
  closed.onerror = (error) => closedErrors.push(error);
  await settle(() => closedErrors.length === 1);
  // 正常结束也要通知调用方，否则断线重连永远不会触发。
  assert.deepEqual(closedErrors[0], { readyState: 0 });
  assert.equal(closed.readyState, 0);
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


async function flush() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function openResponse(text = "") {
  return new Response(new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
    },
  }));
}

test("EOF, network failure and 5xx use one bounded retry loop carrying Last-Event-ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  const states = [];
  const stream = createEventStream("http://test/events", {
    retryDelayMs: 5,
    maxRetryDelayMs: 10,
    fetchImpl: async (_url, init) => {
      requests.push(new Headers(init.headers).get("last-event-id"));
      if (requests.length === 1) return new Response(streamOf(["id: 42\r\nretry: 999999999999999999999999999999999999999999\r\n\r\n"]));
      if (requests.length === 2) throw new TypeError("network dropped");
      if (requests.length === 3) return new Response("busy", { status: 503 });
      return openResponse("data: recovered\r\n\r\n");
    },
  });
  t.after(() => stream.close());
  stream.onerror = () => states.push(stream.readyState);
  const messages = [];
  stream.onmessage = (event) => messages.push(event);
  await flush();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(requests.length, attempt);
    t.mock.timers.tick(9);
    await flush();
    assert.equal(requests.length, attempt);
    t.mock.timers.tick(1);
    await flush();
  }
  assert.deepEqual(requests, [null, "42", "42", "42"]);
  assert.deepEqual(states, [0, 0, 0]);
  assert.equal(stream.readyState, 1);
  assert.equal(messages[0].data, "recovered");
});

test("SSE handles byte splits, CRLF, bare CR, comments, custom events and id reset", async (t) => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode("\ufeff: heartbeat\r\nid: first\r\nevent: custom\r\ndata: héllo\r\ndata:  world\r\n\r\n" +
    "id: ignored\0value\rdata: next\r\r" +
    "id:\r\n\r\ndata\r\n\r\n" +
    "event: stale\r\n\r\ndata: default\r\n\r\n" +
    "id: uncommitted\ndata: discarded");
  const requests = [];
  const stream = createEventStream("http://test/events", {
    retryDelayMs: 1,
    fetchImpl: async (_url, init) => {
      requests.push(new Headers(init.headers).get("last-event-id"));
      if (requests.length > 1) return openResponse();
      return new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }));
    },
  });
  t.after(() => stream.close());
  const custom = [];
  const messages = [];
  stream.addEventListener("custom", (event) => custom.push(event));
  stream.onmessage = (event) => messages.push(event);
  await settle(() => requests.length === 2);
  assert.deepEqual(custom, [{ data: "héllo\n world", lastEventId: "first", type: "custom" }]);
  assert.deepEqual(messages.map(({ data, lastEventId }) => [data, lastEventId]), [
    ["next", "first"], ["", ""], ["default", ""],
  ]);
  assert.equal(requests[1], null);
});

test("retry accepts only digits and retains a server delay across reconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const stream = createEventStream("http://test/events", {
    retryDelayMs: 20,
    fetchImpl: async () => {
      requests += 1;
      return new Response(streamOf(["retry: 4\r\nretry: -1\r\nretry: 1.5\r\nretry: nope\r\n\r\n"]));
    },
  });
  t.after(() => stream.close());
  await flush();
  t.mock.timers.tick(3);
  await flush();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(requests, 2);
  stream.close();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(requests, 2);
});

test("401/403 and other terminal HTTP errors never retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [401, 403, 404, 204]) {
    let requests = 0;
    const stream = createEventStream("http://test/events", {
      retryDelayMs: 1,
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status });
      },
    });
    const errors = [];
    stream.onerror = (error) => errors.push([error.status, stream.readyState]);
    await flush();
    t.mock.timers.tick(100);
    await flush();
    assert.deepEqual(errors, [[status, 2]]);
    assert.equal(requests, 1);
  }
});

test("pre-aborted signal never fetches; abort cancels reader and suppresses queued frames", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let requests = 0;
  const closed = createEventStream("http://test/events", {
    signal: preAborted.signal,
    fetchImpl: async () => { requests += 1; return openResponse(); },
  });
  assert.equal(closed.readyState, 2);
  assert.equal(requests, 0);

  const abort = new AbortController();
  let cancelled = false;
  const events = [];
  const active = createEventStream("http://test/events", {
    signal: abort.signal,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\r\n\r\ndata: two\r\n\r\n"));
      },
      cancel() { cancelled = true; },
    })),
  });
  active.onmessage = (event) => { events.push(event.data); abort.abort(); };
  active.addEventListener("message", () => events.push("listener after close"));
  active.onerror = () => events.push("error after close");
  await flush();
  assert.deepEqual(events, ["one"]);
  assert.equal(cancelled, true);
  assert.equal(active.readyState, 2);
});

test("closing an idle reader cancels its pending read without reconnecting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  let requests = 0;
  let errors = 0;
  const stream = createEventStream("http://test/events", {
    retryDelayMs: 1,
    fetchImpl: async () => {
      requests += 1;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    },
  });
  stream.onerror = () => { errors += 1; };
  await flush();
  assert.equal(stream.readyState, 1);
  stream.close();
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
  assert.equal(errors, 0);
});

test("close during fetch cancels a late response with no callbacks", async () => {
  let resolveResponse;
  let cancelled = false;
  const events = [];
  const stream = createEventStream("http://test/events", {
    fetchImpl: () => new Promise((resolve) => { resolveResponse = resolve; }),
  });
  stream.onopen = () => events.push("open");
  stream.onerror = () => events.push("error");
  stream.onmessage = () => events.push("message");
  stream.close();
  resolveResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await flush();
  assert.equal(cancelled, true);
  assert.deepEqual(events, []);
});

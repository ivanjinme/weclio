import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentClient, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent client preserves the command payload, encoded session id and result envelope", async (t) => {
  const command = { type: "fork", entryId: "entry", includeEntry: true };
  const result = { cancelled: false, newSessionId: "child" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/agent/session%2Fid");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), command);
    return Response.json({ success: true, data: result });
  });
  assert.deepEqual(await sendAgentCommand("session/id", command), result);
});

test("agent client preserves null command results", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: null }));
  assert.equal(await sendAgentCommand("session", { type: "abort" }), null);
});

test("agent client surfaces server errors even in a successful HTTP response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Cannot fork while busy" }));
  await assert.rejects(sendAgentCommand("session", { type: "fork", entryId: "entry" }), /Cannot fork while busy/);
});

test("agent client uses HTTP status when the error response is not JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  await assert.rejects(sendAgentCommand("session", { type: "get_state" }), /HTTP 503/);
});

test("agent client rejects a successful HTTP response without a data field", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true }));
  await assert.rejects(sendAgentCommand("session", { type: "get_state" }), (error) => {
    assert.equal(error.code, "invalid_response");
    return true;
  });
});

test("agent client rejects a non-JSON success response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ok", { status: 200 }));
  await assert.rejects(sendAgentCommand("session", { type: "get_state" }), (error) => {
    assert.equal(error.code, "http_error");
    return true;
  });
});

test("agent client surfaces the protocol error code and request id", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(
    { success: false, error: { code: "invalid_argument", message: "message must be a string", requestId: "req-1" } },
    { status: 400 },
  ));
  await assert.rejects(sendAgentCommand("session", { type: "prompt", message: "hi" }), (error) => {
    assert.equal(error.code, "invalid_argument");
    assert.equal(error.requestId, "req-1");
    assert.match(error.message, /must be a string/);
    return true;
  });
});

test("agent client falls back to the response header for the request id", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", {
    status: 404,
    headers: { "x-request-id": "header-1" },
  }));
  await assert.rejects(sendAgentCommand("session", { type: "abort" }), (error) => {
    assert.equal(error.code, "http_error");
    assert.equal(error.requestId, "header-1");
    return true;
  });
});

test("agent client accepts an injected endpoint, base path and auth headers", async (t) => {
  const client = createAgentClient({
    baseUrl: "https://vm.example:8443/",
    basePath: "/v1",
    headers: () => ({ Authorization: "Bearer fixture" }),
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://vm.example:8443/v1/agent/session");
    assert.equal(options.headers.Authorization, "Bearer fixture");
    assert.equal(options.headers["Content-Type"], "application/json");
    return Response.json({ success: true, data: null });
  });
  assert.equal(await client.sendCommand("session", { type: "abort" }), null);
});

test("agent client forwards an abort signal and preserves abort errors", async (t) => {
  const controller = new AbortController();
  const abort = new DOMException("aborted", "AbortError");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    throw abort;
  });
  const client = createAgentClient();
  await assert.rejects(client.sendCommand("session", { type: "abort" }, { signal: controller.signal }), (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});

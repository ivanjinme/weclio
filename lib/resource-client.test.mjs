import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { acquireResource, downloadResource, RESOURCE_BLOB_MAX_BYTES: LIMIT } = await jiti.import("./resource-client.ts");
const { configureApiBase, resetApiBase } = await jiti.import("./api-base.ts");
const { setAgentCredential, resetAgentCredential } = await jiti.import("./agent-credential.ts");
const TOKEN = "private-bearer-token";
const request = { filePath: "/workspace/图 chart.png", kind: "preview", sessionId: "session & one", revision: 7 };

function stub(t, object, key, value) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  t.after(() => original ? Object.defineProperty(object, key, original) : delete object[key]);
}

function setup(t, respond) {
  configureApiBase({ baseUrl: "https://service.example", basePath: "/v1" });
  setAgentCredential(TOKEN);
  t.after(() => { resetApiBase(); resetAgentCredential(); });
  const calls = [];
  stub(t, globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), ...init, headers: new Headers(init?.headers) });
    return respond(calls.at(-1), calls.length);
  });
  const created = [];
  const revoked = [];
  stub(t, URL, "createObjectURL", (blob) => { created.push(blob); return `blob:test-${created.length}`; });
  stub(t, URL, "revokeObjectURL", (url) => revoked.push(url));
  return { calls, created, revoked };
}

function ticket(value = "opaque+ticket/&") {
  return Response.json({ ticket: value, expiresAt: Date.now() + 60_000 });
}

function assertAuthenticated(calls) {
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(call.url.includes(TOKEN), false);
  }
}

test("bash-output ticket POST binds source, session, kind and file without metadata fetch", async (t) => {
  const { calls, created } = setup(t, () => ticket());
  const bash = { filePath: "/tmp/bash output #1.txt", kind: "download", sessionId: "session/& one", source: "bash-output" };
  const lease = await acquireResource(bash);
  assert.equal(lease.transport, "ticket");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://service.example/v1/resources/tickets");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), bash);
  assertAuthenticated(calls);
  assert.equal(created.length, 0);
});

for (const basePath of ["/api", "/v1"]) {
  test(`${basePath} bash-output source requires download kind and a nonempty session before any fetch`, async (t) => {
    const { calls } = setup(t, () => { throw new Error("unexpected fetch"); });
    configureApiBase({ baseUrl: "", basePath });
    for (const invalid of [
      { kind: "read", sessionId: "s1" }, { kind: "preview", sessionId: "s1" },
      { kind: "download" }, { kind: "download", sessionId: null }, { kind: "download", sessionId: "" },
    ]) {
      await assert.rejects(acquireResource({ filePath: "/tmp/output.txt", source: "bash-output", ...invalid }), /requires a session/);
    }
    assert.equal(calls.length, 0);
  });
}

test("Next bash-output source retains existing session bash-output download route", async (t) => {
  const { calls } = setup(t, () => { throw new Error("unexpected fetch"); });
  configureApiBase({ baseUrl: "", basePath: "/api" });
  const lease = await acquireResource({ filePath: "/tmp/output & #1.txt", kind: "download", sessionId: "s/ &1", source: "bash-output" });
  assert.equal(lease.transport, "direct");
  assert.equal(lease.url, "/api/agent/s%2F%20%261/bash-output?path=%2Ftmp%2Foutput%20%26%20%231.txt&download=1");
  assert.equal(calls.length, 0);
});

test("Next retains historical direct URL with path, session and revision and performs no fetch", async (t) => {
  const { calls, created } = setup(t, () => { throw new Error("unexpected fetch"); });
  configureApiBase({ baseUrl: "", basePath: "/api" });
  const lease = await acquireResource(request);
  assert.equal(lease.transport, "direct");
  assert.equal(lease.url, "/api/files/workspace/%E5%9B%BE%20chart.png?type=preview&sessionId=session+%26+one&v=7");
  lease.release();
  lease.release();
  assert.equal(calls.length, 0);
  assert.equal(created.length, 0);
});

test("small v1 resource fetches authenticated metadata/content and revokes each independent Blob once", async (t) => {
  const { calls, created, revoked } = setup(t, (call) => new URL(call.url).searchParams.get("type") === "meta"
    ? Response.json({ size: 3 }) : new Response("abc", { headers: { "content-type": "image/png" } }));
  const first = await acquireResource(request);
  const second = await acquireResource(request);
  assert.equal(first.transport, "blob");
  assert.equal(second.transport, "blob");
  assert.notEqual(first.url, second.url);
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[0].url).searchParams.get("sessionId"), request.sessionId);
  assert.equal(new URL(calls[1].url).searchParams.get("v"), "7");
  assert.equal(created[0].type, "image/png");
  assert.equal(await created[0].text(), "abc");
  assertAuthenticated(calls);
  first.release(); first.release();
  assert.deepEqual(revoked, [first.url]);
  second.release();
  assert.deepEqual(revoked, [first.url, second.url]);
});

for (const variant of [
  { name: "native preview", request, options: { native: true } },
  { name: "SVG preview preserves server CSP", request: { ...request, filePath: "/workspace/image.SVG" } },
  { name: "download", request: { ...request, kind: "download" } },
]) {
  test(`${variant.name} skips metadata/Blob and obtains a ticket from the current Service`, async (t) => {
    const { calls, created } = setup(t, () => ticket());
    const lease = await acquireResource(variant.request, variant.options);
    assert.equal(lease.transport, "ticket");
    assert.ok(lease.expiresAt > Date.now());
    const url = new URL(lease.url);
    assert.equal(url.origin, "https://service.example");
    assert.equal(url.pathname, "/v1/resources/content");
    assert.deepEqual([...url.searchParams], [["ticket", "opaque+ticket/&"]]);
    assert.equal(lease.url.includes(TOKEN), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://service.example/v1/resources/tickets");
    assert.deepEqual(JSON.parse(calls[0].body), {
      filePath: variant.request.filePath, kind: variant.request.kind, sessionId: variant.request.sessionId,
    });
    assertAuthenticated(calls);
    assert.equal(created.length, 0);
    lease.release(); lease.release();
  });
}

test("metadata size boundary allows exactly 2 MiB and sends larger resources directly to tickets", async (t) => {
  let size = LIMIT;
  const { calls, created } = setup(t, (call) => {
    if (call.url.includes("resources/tickets")) return ticket();
    if (new URL(call.url).searchParams.get("type") === "meta") return Response.json({ size });
    return new Response(new Uint8Array(size));
  });
  const small = await acquireResource(request);
  assert.equal(small.transport, "blob");
  assert.equal(created[0].size, LIMIT);
  small.release();
  size = LIMIT + 1;
  const large = await acquireResource(request);
  assert.equal(large.transport, "ticket");
  assert.equal(calls.length, 4);
  assert.equal(created.length, 1);
});

for (const declaredLength of [undefined, LIMIT + 1]) {
  test(`growing content falls back to ticket and cancels body (${declaredLength ? "oversized header" : "stream overflow"})`, async (t) => {
    let cancelled = 0;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled++; },
    });
    const { calls, created } = setup(t, (_call, index) => {
      if (index === 1) return Response.json({ size: 1 });
      if (index === 2) return new Response(body, { headers: declaredLength ? { "content-length": String(declaredLength) } : {} });
      return ticket();
    });
    const lease = await acquireResource(request);
    assert.equal(lease.transport, "ticket");
    assert.equal(cancelled, 1);
    assert.equal(created.length, 0);
    assert.equal(calls.length, 3);
  });
}

test("pre-aborted acquisition does not fetch; pending authenticated fetch receives abort signal", async (t) => {
  const controller = new AbortController();
  const { calls } = setup(t, (call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
  }));
  controller.abort();
  await assert.rejects(acquireResource(request, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls.length, 0);
  const pendingController = new AbortController();
  const pending = acquireResource(request, { signal: pendingController.signal });
  assert.equal(calls[0].signal, pendingController.signal);
  pendingController.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("abort cancels a pending stream and never allocates a late Blob or requests a ticket", async (t) => {
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  let cancelled = 0;
  const body = new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } });
  const { calls, created } = setup(t, (_call, index) => index === 1 ? Response.json({ size: 1 }) : new Response(body));
  const controller = new AbortController();
  const pending = acquireResource(request, { signal: controller.signal });
  await reading;
  // 等到 metadata 的异步解析完成并进入 body reader。
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
  assert.equal(created.length, 0);
  assert.equal(calls.length, 2);
});

test("late ticket response after abort is discarded", async (t) => {
  let resolve;
  setup(t, () => new Promise((done) => { resolve = done; }));
  const controller = new AbortController();
  const pending = acquireResource(request, { native: true, signal: controller.signal });
  controller.abort();
  resolve(ticket());
  await assert.rejects(pending, { name: "AbortError" });
});

test("HTTP error does not expose response body, ticket or bearer token", async (t) => {
  setup(t, () => new Response(`ticket=secret-ticket token=${TOKEN}`, { status: 403 }));
  await assert.rejects(acquireResource(request, { native: true }), (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /secret-ticket|private-bearer-token/);
    return true;
  });
});

test("transport errors redact credentials and capability URLs before surfacing to callers", async (t) => {
  setup(t, () => { throw new Error(`Failed https://service.example/v1/resources/content?ticket=secret-ticket Authorization: Bearer ${TOKEN}`); });
  await assert.rejects(acquireResource(request, { native: true }), (error) => {
    assert.doesNotMatch(error.message, /secret-ticket|private-bearer-token|resources\/content\?ticket/);
    return true;
  });
});

test("each download click obtains a fresh ticket and removes its native anchor", async (t) => {
  const { calls } = setup(t, (_call, index) => ticket(`ticket-${index}`));
  const anchors = [];
  const appended = [];
  stub(t, globalThis, "document", {
    createElement(tag) {
      assert.equal(tag, "a");
      const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild(anchor) { appended.push(anchor); } },
  });
  await downloadResource(request.filePath, request.sessionId);
  await downloadResource(request.filePath, request.sessionId);
  assert.equal(calls.length, 2);
  assert.equal(anchors.length, 2);
  assert.deepEqual(appended, anchors);
  assert.notEqual(anchors[0].href, anchors[1].href);
  for (const anchor of anchors) {
    assert.equal(anchor.download, "图 chart.png");
    assert.equal(anchor.referrerPolicy, "no-referrer");
    assert.equal(anchor.clicked, true);
    assert.equal(anchor.removed, true);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { agentAuthHeaders, setAgentCredential, resetAgentCredential } = await jiti.import("./agent-credential.ts");
const { configureApiBase, resetApiBase } = await jiti.import("./api-base.ts");
const { apiFetch } = await jiti.import("./api-fetch.ts");
const { createAgentClient } = await jiti.import("./agent-client.ts");
const { createEventStream } = await jiti.import("./event-stream.ts");

function selectedService(t) {
  configureApiBase({ baseUrl: "https://service.test:8443", basePath: "/v1" });
  setAgentCredential("selected-token");
  t.after(() => { resetAgentCredential(); resetApiBase(); });
}

test("implicit credentials require the selected origin and path boundary", (t) => {
  selectedService(t);
  for (const url of ["https://service.test:8443/v1", "https://service.test:8443/v1/sessions?x=1"]) {
    assert.equal(agentAuthHeaders(url).get("authorization"), "Bearer selected-token", url);
  }
  for (const url of [
    "https://external.test/v1/sessions", "http://service.test:8443/v1/sessions",
    "https://service.test/v1/sessions", "https://service.test:8443/v10/sessions",
    "https://service.test:8443/other", "https://service.test:8443/v1/../other",
    "//external.test/v1/sessions", "//service.test:8443/v1/sessions",
    "/\\external.test/v1/sessions", "https://service.test:8443/v1/%2e%2e/other",
  ]) {
    assert.equal(agentAuthHeaders(url).get("authorization"), null, url);
    assert.equal(agentAuthHeaders(url, { Authorization: "Bearer explicit" }).get("authorization"), "Bearer explicit");
  }
});

test("apiFetch does not leak credentials to external, protocol-relative or outside-prefix URLs", async (t) => {
  selectedService(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return Response.json({});
  });
  for (const url of ["https://external.test/data", "//external.test/v1/data", "https://service.test:8443/other"]) {
    await apiFetch(url);
    assert.equal(calls.at(-1).url, url);
    assert.equal(calls.at(-1).headers.get("authorization"), null);
  }
  await apiFetch("/sessions");
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer selected-token");
  await apiFetch("/sessions", { headers: { authorization: "Bearer explicit" } });
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer explicit");
  await apiFetch("/sessions", { anonymous: true });
  assert.equal(calls.at(-1).headers.get("authorization"), null);
});

test("custom clients never inherit the token for another environment; callbacks remain honored", async (t) => {
  selectedService(t);
  const fetch = async (_url, init) => {
    return Response.json({ success: true, data: new Headers(init.headers).get("authorization") });
  };
  assert.equal(await createAgentClient({ fetch }).sendCommand("s", { type: "abort" }), "Bearer selected-token");
  for (const config of [
    { baseUrl: "https://other.test" },
    { basePath: "/other" },
    { routes: { commands: () => "//external.test/v1/sessions/s/commands" } },
  ]) {
    assert.equal(await createAgentClient({ ...config, fetch }).sendCommand("s", { type: "abort" }), null);
    const client = createAgentClient({ ...config, fetch, headers: async () => ({ Authorization: "Bearer custom" }) });
    assert.equal(await client.sendCommand("s", { type: "abort" }), "Bearer custom");
  }
});

test("SSE uses scoped auth without changing explicit authorization", async (t) => {
  selectedService(t);
  for (const [url, explicit, expected] of [
    ["https://service.test:8443/v1/events", undefined, "Bearer selected-token"],
    ["https://external.test/v1/events", undefined, null],
    ["//external.test/v1/events", undefined, null],
    ["https://service.test:8443/other/events", undefined, null],
    ["https://external.test/v1/events", "Bearer custom", "Bearer custom"],
  ]) {
    let actual;
    const stream = createEventStream(url, {
      headers: explicit ? { Authorization: explicit } : undefined,
      fetchImpl: async (_url, init) => {
        actual = new Headers(init.headers).get("authorization");
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(actual, expected, url);
    stream.close();
  }
});

test("browser-relative URLs resolve against the UI origin, not a remote Service", (t) => {
  selectedService(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: new URL("https://ui.test/app"),
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "location", original);
    else delete globalThis.location;
  });
  assert.equal(agentAuthHeaders("/v1/sessions").get("authorization"), null);
  configureApiBase({ basePath: "/v1" });
  assert.equal(agentAuthHeaders("https://ui.test/v1/sessions/s").get("authorization"), "Bearer selected-token");
  assert.equal(agentAuthHeaders("/v1/sessions/s").get("authorization"), "Bearer selected-token");
  assert.equal(agentAuthHeaders("https://external.test/v1/sessions/s").get("authorization"), null);
});

test("explicit same-origin Service selection supports scoped in-memory startup tokens only", (t) => {
  t.after(() => { resetAgentCredential(); resetApiBase(); });
  resetApiBase();
  resetAgentCredential();
  assert.equal(agentAuthHeaders("/v1/sessions/s").get("authorization"), null);
  configureApiBase({ basePath: "/v1" });
  setAgentCredential("local-token");
  assert.equal(agentAuthHeaders("/v1/sessions/s").get("authorization"), "Bearer local-token");
  assert.equal(agentAuthHeaders("/api/agent/s").get("authorization"), null);
  assert.equal(agentAuthHeaders("/other").get("authorization"), null);
  assert.equal(agentAuthHeaders("https://external.test/v1/sessions/s").get("authorization"), null);
});

test("resetting Service selection prevents a retained token from authenticating an implicit default URL", (t) => {
  selectedService(t);
  resetApiBase();
  assert.equal(agentAuthHeaders("/v1/sessions/s").get("authorization"), null);
});

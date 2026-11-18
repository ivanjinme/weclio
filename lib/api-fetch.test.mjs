import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { apiFetch } = await jiti.import("./api-fetch.ts");
const { configureApiBase, resetApiBase } = await jiti.import("./api-base.ts");
const { setAgentCredential, resetAgentCredential } = await jiti.import("./agent-credential.ts");

test("api fetch prefixes the configured base and attaches the token", async (t) => {
  t.after(() => {
    resetApiBase();
    resetAgentCredential();
  });

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({ ok: true });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  configureApiBase({ baseUrl: "http://127.0.0.1:8899", basePath: "/v1" });
  setAgentCredential("service-token");

  assert.deepEqual(await (await apiFetch("/sessions")).json(), { ok: true });
  assert.equal(calls[0].url, "http://127.0.0.1:8899/v1/sessions");
  assert.equal(calls[0].headers.get("authorization"), "Bearer service-token");

  // 绝对 URL 原样使用，不再拼基址。
  await apiFetch("http://example.test/ping");
  assert.equal(calls[1].url, "http://example.test/ping");

  // 匿名调用不附加令牌。
  await apiFetch("/healthz", { anonymous: true });
  assert.equal(calls[2].headers.get("authorization"), null);
});

test("clearing the credential removes the authorization header", async (t) => {
  configureApiBase({ basePath: "/v1" });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(new Headers(init?.headers));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = original;
    resetApiBase();
    resetAgentCredential();
  });

  setAgentCredential("temp");
  await apiFetch("/sessions");
  setAgentCredential(null);
  await apiFetch("/sessions");

  assert.equal(calls[0].get("authorization"), "Bearer temp");
  assert.equal(calls[1].get("authorization"), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { apiUrl, configureApiBase, getApiBase, resetApiBase } = await jiti.import("./api-base.ts");

test.afterEach(() => resetApiBase());

test("defaults to same-origin /api, matching pre-split behaviour", () => {
  assert.deepEqual(getApiBase(), { baseUrl: "", basePath: "/api" });
  assert.equal(apiUrl("/agent/s1"), "/api/agent/s1");
  assert.equal(apiUrl("agent/s1"), "/api/agent/s1");
});

test("joins a remote base and custom prefix without doubling slashes", () => {
  configureApiBase({ baseUrl: "https://vm.example:8443/", basePath: "/v1/" });
  assert.equal(apiUrl("/agent/s1"), "https://vm.example:8443/v1/sessions/s1/state");
});

test("absolute URLs pass through untouched", () => {
  configureApiBase({ baseUrl: "https://vm.example", basePath: "/v1" });
  assert.equal(apiUrl("https://other.example/x"), "https://other.example/x");
});

test("rejects a prefix without a leading slash", () => {
  assert.throws(() => configureApiBase({ basePath: "v1" }), /must start with/);
});

test("reset restores the default configuration", () => {
  configureApiBase({ baseUrl: "https://vm.example", basePath: "/v1" });
  resetApiBase();
  assert.equal(apiUrl("/agent/s1"), "/api/agent/s1");
});

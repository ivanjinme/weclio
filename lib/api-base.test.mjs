import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { apiUrl, configureApiBase, getApiBase, isApiBaseConfigured, resetApiBase } = await jiti.import("./api-base.ts");

test.afterEach(() => resetApiBase());

test("the Service prefix defaults to /v1 but no backend is selected implicitly", () => {
  assert.deepEqual(getApiBase(), { baseUrl: "", basePath: "/v1" });
  assert.equal(isApiBaseConfigured(), false);
  assert.throws(() => apiUrl("/agent/s1"), /not configured/);
  assert.throws(() => apiUrl("/v1/sessions"), /not configured/);
});

test("joins a selected remote Service with the default prefix and translates UI suffixes", () => {
  configureApiBase({ baseUrl: "https://vm.example:8443/" });
  assert.equal(isApiBaseConfigured(), true);
  assert.equal(apiUrl("/agent/s1"), "https://vm.example:8443/v1/sessions/s1/state");
  assert.equal(apiUrl("agent/s1"), "https://vm.example:8443/v1/sessions/s1/state");
  assert.equal(apiUrl("/agent/new", "POST"), "https://vm.example:8443/v1/sessions");
  assert.equal(apiUrl("/sessions", "POST"), "https://vm.example:8443/v1/sessions/titles");
});

test("same-origin Service is supported only through deliberate configuration", () => {
  configureApiBase({ basePath: "/v1/" });
  assert.equal(apiUrl("/cwd/default"), "/v1/workspaces/default");
  assert.equal(apiUrl(apiUrl("/cwd/default")), "/v1/workspaces/default");
});

test("explicit absolute URLs pass through untouched", () => {
  assert.equal(apiUrl("https://other.example/x"), "https://other.example/x");
});

test("invalid and retired backend prefixes are rejected without selecting a backend", () => {
  assert.throws(() => configureApiBase({ basePath: "v1" }), /must start with/);
  for (const basePath of ["/api", "/api/", "/api/nested", "/v1/../api", "/%61pi"]) {
    assert.throws(() => configureApiBase({ basePath }), /retired/);
  }
  assert.equal(isApiBaseConfigured(), false);
});

test("reset clears selection instead of silently falling back to a same-origin backend", () => {
  configureApiBase({ baseUrl: "https://vm.example" });
  resetApiBase();
  assert.equal(isApiBaseConfigured(), false);
  assert.throws(() => apiUrl("/agent/s1"), /not configured/);
});

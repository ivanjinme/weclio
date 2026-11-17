import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { apiUrl, configureApiBase, resetApiBase } = await jiti.import("../api-base.ts");
test.afterEach(resetApiBase);

const pairs = [
  ["/sidebar-pins", "/settings/pins"],
  ["/agent/new", "/sessions", "POST"],
  ["/cwd/default", "/workspaces/default"],
  ["/cwd/validate", "/workspaces/validate"],
  ["/cwd/browse?path=D%3A%2F", "/workspaces/browse?path=D%3A%2F"],
  ["/sessions", "/sessions"],
  ["/sessions", "/sessions/titles", "POST"],
  ["/project-trust?cwd=%2Fw", "/projects/trust?cwd=%2Fw"],
  ["/file-index?cwd=%2Fw&q=test", "/files/index?cwd=%2Fw&q=test"],
  ["/models-config", "/settings/models"],
  ["/models-config/default", "/settings/models/default"],
  ["/models-config/providers/p", "/settings/models/providers/p"],
  ["/auth/providers", "/provider-auth/oauth"],
  ["/auth/all-providers", "/provider-auth/providers"],
  ["/auth/api-key/p", "/provider-auth/api-key/p"],
  ["/auth/login/p", "/provider-auth/login/p"],
  ["/agent/s%2F1", "/sessions/s%2F1/state"],
  ["/agent/s1/bash-output?path=%2Ftmp%2Flog", "/sessions/s1/bash-output?path=%2Ftmp%2Flog"],
];

test("UI paths resolve to the service contract, including POST title batches", () => {
  configureApiBase({ baseUrl: "http://127.0.0.1:8891", basePath: "/v1" });
  for (const [input, expected, method] of pairs) {
    const resolved = apiUrl(input, method);
    assert.equal(resolved, `http://127.0.0.1:8891/v1${expected}`);
    assert.equal(apiUrl(resolved), resolved, "apiFetch(apiUrl(...)) must not re-map resolved URLs");
  }
});

test("the Next host retains every historical UI path and verb", () => {
  resetApiBase();
  for (const [input, , method] of pairs) assert.equal(apiUrl(input, method), `/api${input}`);
});

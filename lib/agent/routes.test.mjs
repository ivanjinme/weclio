import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createRoutes, resolveApiPath, routesForBase } = await jiti.import("./routes.ts");

for (const baseUrl of ["", "https://vm.example:8443"]) {
  test(`Service routes use the explicit base ${baseUrl || "(same origin)"}`, () => {
    const routes = routesForBase({ baseUrl, basePath: "/v1" });
    assert.equal(routes.commands("s 1"), `${baseUrl}/v1/sessions/s%201/commands`);
    assert.equal(routes.events("s1"), `${baseUrl}/v1/sessions/s1/events`);
    assert.equal(routes.events("s1", "C:/work"), `${baseUrl}/v1/sessions/s1/events?cwd=C%3A%2Fwork`);
    assert.equal(routes.runningEvents(), `${baseUrl}/v1/events`);
    assert.equal(routes.state("s1"), `${baseUrl}/v1/sessions/s1/state`);
    assert.equal("profile" in routes, false);
  });
}

test("retired Next backend prefixes cannot select a route table", () => {
  for (const basePath of ["/api", "/api/", "/api/nested", "/v1/../api", "/%61pi"]) {
    assert.throws(() => createRoutes({ baseUrl: "", basePath }), /retired/);
  }
});

test("historical UI suffixes translate only on the client, preserving queries and methods", () => {
  for (const [path, method, expected] of [
    ["/agent/new", "POST", "/sessions"],
    ["/sessions", "POST", "/sessions/titles"],
    ["/sessions", "GET", "/sessions"],
    ["/agent/s1?cwd=%2Fw", "GET", "/sessions/s1/state?cwd=%2Fw"],
    ["/agent/running/events", "GET", "/events"],
    ["/cwd/default", "GET", "/workspaces/default"],
    ["/cwd/validate", "POST", "/workspaces/validate"],
    ["/cwd/browse?path=x", "GET", "/workspaces/browse?path=x"],
    ["/models-config/provider", "PATCH", "/settings/models/provider"],
    ["/auth/providers", "GET", "/provider-auth/oauth"],
    ["/agent/s1/bash-output?path=x", "GET", "/sessions/s1/bash-output?path=x"],
    ["/sessions/s1/commands", "POST", "/sessions/s1/commands"],
  ]) assert.equal(resolveApiPath(path, method), expected);
});

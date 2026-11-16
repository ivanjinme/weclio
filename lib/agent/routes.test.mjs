import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createRoutes, resolveHostProfile } = await jiti.import("./routes.ts");
// 路由表由显式基址决定，不读全局状态。
const BASE = { baseUrl: "", basePath: "/api" };
const { resetApiBase } = await jiti.import("../api-base.ts");

test.afterEach(() => resetApiBase());

test("the profile is inferred from the API base path", () => {
  assert.equal(resolveHostProfile("/api"), "next");
  assert.equal(resolveHostProfile("/api/"), "next");
  assert.equal(resolveHostProfile("/v1"), "service");
  assert.equal(resolveHostProfile("/v1/"), "service");
});

test("the next host keeps its historical command and event paths", () => {
  const routes = createRoutes("next", BASE);
  assert.equal(routes.commands("s 1"), "/api/agent/s%201");
  assert.equal(routes.events("s1"), "/api/agent/s1/events");
  assert.equal(routes.runningEvents(), "/api/agent/running/events");
  assert.equal(routes.state("s1"), "/api/sessions/s1/state");
});

test("the service host uses versioned REST paths", () => {
  const routes = createRoutes("service", BASE);
  assert.equal(routes.commands("s 1"), "/api/sessions/s%201/commands");
  assert.equal(routes.events("s1"), "/api/sessions/s1/events");
  assert.equal(routes.events("s1", "C:/work"), "/api/sessions/s1/events?cwd=C%3A%2Fwork");
  assert.equal(routes.runningEvents(), "/api/events");
  assert.equal(routes.state("s1"), "/api/sessions/s1/state");
});

test("a configured remote base and /v1 prefix produce service URLs", () => {
  const base = { baseUrl: "https://vm.example:8443", basePath: "/v1" };
  const routes = createRoutes(resolveHostProfile(base.basePath), base);
  assert.equal(routes.commands("s1"), "https://vm.example:8443/v1/sessions/s1/commands");
  assert.equal(routes.events("s1"), "https://vm.example:8443/v1/sessions/s1/events");
});

test("every profile covers the same endpoint set", () => {
  for (const profile of ["next", "service"]) {
    const routes = createRoutes(profile, BASE);
    for (const key of ["commands", "events", "runningEvents", "state"]) {
      assert.equal(typeof routes[key], "function", `${profile}.${key}`);
      const url = routes[key]("s1");
      // runningEvents 是全局运行态流，其余按会话寻址。
      assert.ok(url.startsWith("/api/"), `${profile}.${key} must use the API base`);
      if (key !== "runningEvents") assert.ok(url.includes("s1"), `${profile}.${key} must address the session`);
    }
  }
});

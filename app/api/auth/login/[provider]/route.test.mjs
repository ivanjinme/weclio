import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 登录编排与失败语义在 lib/agent/oauth-login-service（见其服务测试）；
// 路由只负责 SSE 传输、断连取消与手动回调转发。
const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("the login route delegates orchestration to the shared service", () => {
  for (const required of [
    "getDefaultOAuthLoginManager()",
    "manager.start(provider, emit)",
    ".submit(token, code)",
  ]) {
    assert.ok(route.includes(required), `route must delegate: ${required}`);
  }
  // 路由不再自带登录流程或回调注册表。
  for (const forbidden of ["ModelRuntime", "createManualLoginToken", "__piLoginCallbacks"]) {
    assert.equal(route.includes(forbidden), false, `route must not own ${forbidden}`);
  }
});

test("the login route streams SSE and cancels on disconnect", () => {
  for (const required of [
    "text/event-stream",
    "data: ",
    'req.signal.addEventListener("abort", cancel',
    "handle.abort()",
    "void handle.done.finally(finish)",
  ]) {
    assert.ok(route.includes(required), `route must contain: ${required}`);
  }
});

test("manual callback requires token and code", () => {
  assert.ok(route.includes('typeof token !== "string" || typeof code !== "string"'));
  assert.ok(route.includes("invalid_argument"));
});

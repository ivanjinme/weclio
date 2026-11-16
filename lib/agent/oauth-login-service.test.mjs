import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createOAuthLoginOptions } from "../oauth-login-options.ts";

// OAuth 登录编排：注入 SDK 运行时与设置写入，验证事件顺序与失败语义。
let createRuntime;
let createOptions;
let order;

const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": { ModelRuntime: { create: () => createRuntime() } },
    "../models-cache": { invalidateModelsCache: () => order.push("invalidate") },
    "../oauth-login-options": { createOAuthLoginOptions: () => createOptions() },
    "../oauth-login-token": { createManualLoginToken: (provider) => `${provider}-token-1` },
  },
});
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const { createOAuthLoginManager } = await jiti.import("./oauth-login-service.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "weclio-oauth-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  order = [];
  createOptions = () => {
    const loginOptions = createOAuthLoginOptions(dir);
    return {
      options: loginOptions.options,
      async flush() {
        order.push("flush-start");
        await loginOptions.flush();
        order.push("flush-end");
      },
    };
  };
  const runtime = {
    getProvider: () => ({ auth: { oauth: true } }),
    async login(_provider, _method, _callbacks, options) {
      options.getDeviceId();
      order.push("authorized");
    },
  };
  createRuntime = async () => runtime;
  return { dir, runtime };
}

async function runLogin(manager, provider = "openai-codex") {
  const events = [];
  const handle = manager.start(provider, (event) => {
    events.push(event);
    order.push(event.type);
  });
  await handle.done;
  return events;
}

test("success is emitted only after the device ID write is flushed", async (t) => {
  const { dir } = fixture(t);
  const events = await runLogin(createOAuthLoginManager());
  assert.deepEqual(events, [{ type: "success" }]);
  assert.deepEqual(order, ["authorized", "invalidate", "flush-start", "flush-end", "success"]);
  assert.ok(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).deviceId);
});

test("a pending flush delays success instead of short-circuiting", async (t) => {
  fixture(t);
  const manager = createOAuthLoginManager();
  const flush = Promise.withResolvers();
  createOptions = () => ({ options: { getDeviceId: () => "device-id" }, flush: () => flush.promise });

  const events = [];
  const handle = manager.start("openai-codex", (event) => { events.push(event); order.push(event.type); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["authorized", "invalidate"]);
  flush.resolve();
  await handle.done;
  assert.deepEqual(events, [{ type: "success" }]);
});

test("local storage failure after authorization emits a distinct error, never success", async (t) => {
  const { dir, runtime } = fixture(t);
  runtime.login = async (_provider, _method, _callbacks, options) => {
    options.getDeviceId();
    mkdirSync(join(dir, "settings.json"));
    order.push("authorized");
  };
  const events = await runLogin(createOAuthLoginManager());
  assert.deepEqual(events, [{
    type: "error",
    message: "OAuth authorization succeeded, but the device ID could not be saved locally",
    code: "device_id_persistence_failed",
  }]);
});

test("corrupt project settings do not turn a successful save into an error", async (t) => {
  const { dir } = fixture(t);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "settings.json"), "{invalid json");
  const events = await runLogin(createOAuthLoginManager());
  assert.deepEqual(events, [{ type: "success" }]);
});

for (const [message, terminal] of [
  ["Provider rejected authorization", { type: "error", message: "Provider rejected authorization" }],
  ["Login cancelled", { type: "cancelled" }],
]) {
  test(`preserves ${message} and still drains queued writes`, async (t) => {
    const { dir, runtime } = fixture(t);
    const reported = [];
    t.mock.method(console, "error", (...args) => reported.push(args));
    runtime.login = async (_provider, _method, callbacks, options) => {
      options.getDeviceId();
      mkdirSync(join(dir, "settings.json"));
      callbacks.notify({ type: "auth_url", url: "https://example.com" });
      throw new Error(message);
    };
    const events = await runLogin(createOAuthLoginManager());
    assert.deepEqual(events.at(-1), terminal);
    assert.equal(events.some(({ type }) => type === "success"), false);
    assert.equal(reported.length, 1);
  });
}

test("options or runtime creation failures surface as SSE errors", async (t) => {
  fixture(t);
  createOptions = () => { throw new Error("Settings initialization failed"); };
  assert.deepEqual(await runLogin(createOAuthLoginManager()), [{ type: "error", message: "Settings initialization failed" }]);

  fixture(t);
  createRuntime = async () => { throw new Error("Runtime initialization failed"); };
  assert.deepEqual(await runLogin(createOAuthLoginManager()), [{ type: "error", message: "Runtime initialization failed" }]);
});

test("providers without an oauth flow are rejected before emitting", async (t) => {
  const { runtime } = fixture(t);
  runtime.getProvider = () => undefined;
  const events = await runLogin(createOAuthLoginManager());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /Unknown provider/);
});

test("manual input is routed back through submit with the issued token", async (t) => {
  const { runtime } = fixture(t);
  runtime.login = async (_provider, _method, callbacks) => {
    callbacks.notify({ type: "auth_url", url: "https://example.com", instructions: "paste the code" });
    // 与真实流程一致：等待浏览器回填或中止。
    await new Promise((_resolve, reject) => {
      callbacks.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
    });
  };

  const manager = createOAuthLoginManager();
  const events = [];
  const handle = manager.start("openai-codex", (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0].type, "auth");
  assert.equal(events[0].token, "openai-codex-token-1");
  assert.equal(events[0].instructions, "paste the code");

  assert.throws(() => manager.submit("unknown-token", "code"), (error) => {
    assert.ok(error instanceof AgentProtocolError);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.throws(() => manager.submit("", ""), (error) => {
    assert.ok(error instanceof AgentProtocolError);
    assert.equal(error.code, "invalid_argument");
    return true;
  });

  // 同一 token 回填后进入手动输入解析；这里只验证 token 被消费一次。
  manager.submit("openai-codex-token-1", "auth-code");
  assert.equal(manager.pendingCount(), 0);

  handle.abort();
  await handle.done;
  assert.equal(events.at(-1).type, "cancelled");
});

test("abort releases pending manual input so the promise cannot hang", async (t) => {
  fixture(t);
  const manager = createOAuthLoginManager();
  const handle = manager.start("openai-codex", () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.pendingCount(), 0);
  handle.abort();
  await handle.done;
});

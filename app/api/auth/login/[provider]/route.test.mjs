import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createOAuthLoginOptions } from "../../../../../lib/oauth-login-options.ts";
import { createOAuthSseWriter } from "../../../../../lib/oauth-sse.ts";

let createRuntime;
let createOptions;
let order;
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": { ModelRuntime: { create: () => createRuntime() } },
    "@/lib/models-cache": { invalidateModelsCache: () => order.push("invalidate") },
    "@/lib/oauth-login-options": { createOAuthLoginOptions: () => createOptions() },
    "@/lib/oauth-login-token": { createManualLoginToken: () => "openai-codex-test" },
    "@/lib/oauth-sse": {
      createOAuthSseWriter: () => {
        const writer = createOAuthSseWriter();
        return {
          ...writer,
          send(controller, event) {
            order.push(event.type);
            writer.send(controller, event);
          },
          close(controller) {
            order.push("close");
            writer.close(controller);
          },
        };
      },
    },
  },
});
const { GET } = await jiti.import("./route.ts");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-oauth-route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previousRegistry = globalThis.__piLoginCallbacks;
  globalThis.__piLoginCallbacks = new Map();
  t.after(() => { globalThis.__piLoginCallbacks = previousRegistry; });
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
  const request = () => GET(new Request("http://localhost/api/auth/login/openai-codex"), {
    params: Promise.resolve({ provider: "openai-codex" }),
  });
  const events = async () => {
    const response = await request();
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    return (await response.text()).split("\n\n").filter(Boolean).map((line) => JSON.parse(line.slice(6)));
  };
  return { dir, runtime, request, events };
}

test("success is emitted only after the real device ID write is flushed", async (t) => {
  const { dir, events } = fixture(t);
  assert.deepEqual(await events(), [{ type: "success" }]);
  assert.deepEqual(order, ["authorized", "invalidate", "flush-start", "flush-end", "success", "close"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).deviceId);
});

test("corrupt project settings do not misreport a successful global device ID save", async (t) => {
  const { dir, events } = fixture(t);
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), "{invalid json");
  assert.deepEqual(await events(), [{ type: "success" }]);
  assert.deepEqual(order, ["authorized", "invalidate", "flush-start", "flush-end", "success", "close"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).deviceId);
});

test("a pending flush delays success instead of closing the stream early", async (t) => {
  const { events } = fixture(t);
  const flush = Promise.withResolvers();
  createOptions = () => ({ options: { getDeviceId: () => "device-id" }, flush: () => flush.promise });
  const result = events();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["authorized", "invalidate"]);
  flush.resolve();
  assert.deepEqual(await result, [{ type: "success" }]);
  assert.deepEqual(order, ["authorized", "invalidate", "success", "close"]);
});

test("real local storage failure after authorization emits a distinct error, never success", async (t) => {
  const { dir, runtime, events } = fixture(t);
  runtime.login = async (_provider, _method, _callbacks, options) => {
    options.getDeviceId();
    fs.mkdirSync(path.join(dir, "settings.json"));
    order.push("authorized");
  };
  assert.deepEqual(await events(), [{
    type: "error",
    message: "OAuth authorization succeeded, but the device ID could not be saved locally",
    code: "device_id_persistence_failed",
  }]);
  assert.deepEqual(order, ["authorized", "invalidate", "flush-start", "error", "close"]);
});

for (const message of ["Provider rejected authorization", "Login cancelled"]) {
  test(`preserves ${message} and drains queued writes without an unhandled rejection`, async (t) => {
    const { dir, runtime, events } = fixture(t);
    const reported = [];
    t.mock.method(console, "error", (...args) => reported.push(args));
    runtime.login = async (_provider, _method, callbacks, options) => {
      options.getDeviceId();
      fs.mkdirSync(path.join(dir, "settings.json"));
      callbacks.notify({ type: "auth_url", url: "https://example.com" });
      throw new Error(message);
    };
    const result = await events();
    const terminal = message === "Login cancelled" ? { type: "cancelled" } : { type: "error", message };
    assert.deepEqual(result.at(-1), terminal);
    assert.equal(result.some(({ type }) => type === "success"), false);
    assert.deepEqual(order.slice(-3), ["flush-start", terminal.type, "close"]);
    assert.equal(globalThis.__piLoginCallbacks.size, 0);
    assert.equal(reported.length, 1);
  });
}

test("options creation failure is reported and the stream is closed", async (t) => {
  const { events } = fixture(t);
  createOptions = () => { throw new Error("Settings initialization failed"); };
  assert.deepEqual(await events(), [{ type: "error", message: "Settings initialization failed" }]);
  assert.deepEqual(order, ["error", "close"]);
});

test("runtime creation failure is reported through the SSE error path", async (t) => {
  const { events } = fixture(t);
  createRuntime = async () => { throw new Error("Runtime initialization failed"); };
  assert.deepEqual(await events(), [{ type: "error", message: "Runtime initialization failed" }]);
  assert.deepEqual(order, ["error", "close"]);
});

test("unknown providers close with an error without creating login options", async (t) => {
  const { runtime, events } = fixture(t);
  runtime.getProvider = () => undefined;
  createOptions = () => { assert.fail("Unknown providers must not initialize settings"); };
  assert.deepEqual(await events(), [{ type: "error", message: "Unknown provider: openai-codex" }]);
  assert.deepEqual(order, ["error", "close"]);
});

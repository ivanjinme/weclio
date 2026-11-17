import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "weclio-auto-name-http-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let generateTitle;
let invalidations = 0;
const reader = {
  resolveSessionPath: async () => join(root, "fixture.jsonl"),
  invalidateSessionListCache: () => { invalidations += 1; },
};
// 仅替换持久读取与模型调用；HTTP、共享业务与 runtime 命名逻辑保持真实。
const jiti = createJiti(import.meta.url, { virtualModules: {
  "./session-title": { generateSessionTitle: (source) => generateTitle(source) },
  "./session-reader": reader,
  "../session-reader": reader,
  "../../session-reader": reader,
} });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { AgentSessionWrapper, AgentRuntime } = await jiti.import("../../rpc-manager.ts");
const { startAgentServiceHost } = await jiti.import("./host.ts");
const runtime = new AgentRuntime();
const token = "fixture-only";
const host = await startAgentServiceHost({ runtime,
  config: { host: "127.0.0.1", port: 0, token, workspace: root },
  serviceId: "test", instanceId: "test", appVersion: "test",
});
test.after(async () => {
  await host.close();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const opened = Promise.withResolvers();
  t.mock.method(SessionManager, "open", () => {
    opened.resolve();
    return { getHeader: () => ({ cwd: root }) };
  });
  invalidations = 0;
  const names = [];
  const inner = {
    sessionId: "auto-name", setSessionName: (name) => names.push(name),
    extensionRunner: { async emit() {} }, dispose() {}, ...overrides,
  };
  const session = new AgentSessionWrapper(inner, { bash: true, powershell: false }, false, runtime);
  runtime.attachSession(session);
  t.after(() => session.shutdown());
  const request = () => fetch(host.url + "/v1/sessions/auto-name/auto-name", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  return { session, inner, names, request, opened: opened.promise };
}

test("HTTP auto-name waits for readiness and invalidates the catalog exactly once", async (t) => {
  const binding = Promise.withResolvers();
  const { session, inner, names, request, opened } = fixture(t, { bindExtensions: () => binding.promise });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
  let generated = false;
  generateTitle = async (source) => {
    assert.equal(source, inner);
    generated = true;
    return { title: "Generated title", usage };
  };
  session.beginExtensionBinding();
  const response = request();
  await opened;
  await nextTurn();
  assert.equal(generated, false);
  binding.resolve();
  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { title: "Generated title", usage });
  assert.deepEqual(names, ["Generated title"]);
  assert.equal(invalidations, 1);
});

test("HTTP auto-name cannot rename a session closed during generation", async (t) => {
  const title = Promise.withResolvers();
  const started = Promise.withResolvers();
  const { session, names, request } = fixture(t);
  generateTitle = () => { started.resolve(); return title.promise; };
  const response = request();
  await started.promise;
  await session.shutdown();
  title.resolve({ title: "Too late" });
  const result = await response;
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, "conflict");
  assert.deepEqual(names, []);
  assert.equal(invalidations, 0);
});

test("HTTP auto-name maps generation failures to 500 without renaming", async (t) => {
  const { names, request } = fixture(t);
  generateTitle = async () => { throw new Error("provider failed"); };
  const result = await request();
  assert.equal(result.status, 500);
  assert.equal((await result.json()).error.message, "provider failed");
  assert.deepEqual(names, []);
  assert.equal(invalidations, 0);
});

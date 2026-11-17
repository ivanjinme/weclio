import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let generate = async () => ({ title: "title" });
const jiti = createJiti(import.meta.url, {
  virtualModules: { "./session-title": { generateSessionTitle: (...args) => generate(...args) } },
});
// SDK 的 proper-lockfile 自带 signal-exit 清理；这里只约束应用 runtime 不注册宿主信号。
await jiti.import("@earendil-works/pi-coding-agent");
const signalCounts = ["exit", "SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
const { AgentRuntime, AgentSessionWrapper, isSessionBusy, autoNameRpcSession } = await jiti.import("../../rpc-manager.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const runtime = new AgentRuntime();
  const inner = {
    sessionId: "gate-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: {} },
    sessionManager: { getCwd: () => process.cwd(), getSessionFile: () => undefined, getEntries: () => [] },
    extensionRunner: { emit: async () => {} },
    subscribe: () => () => {}, dispose() {},
    prompt: async () => {}, abort: async () => {}, abortBash() {}, abortCompaction() {},
    getAllTools: () => [], getActiveToolNames: () => [],
  };
  const session = new AgentSessionWrapper(inner, { bash: true, powershell: false }, false, runtime);
  runtime.attachSession(session);
  const status = (lock = true) => {
    const busy = () => runtime.hasBusyTasks();
    return (lock ? runtime.admission.tryLock(busy) : !runtime.admission.isBusy(busy)) ? "ready" : "busy";
  };
  t.after(async () => { runtime.admission.unlock(); await session.shutdown(); });
  return { inner, session, runtime, status };
}

test("runtime import and construction leave process lifecycle ownership to the host", () => {
  new AgentRuntime();
  assert.deepEqual(["exit", "SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal)), signalCounts);
});

test("pending admissions atomically reject a lock and locked admission rejects new work", (t) => {
  const { runtime, status } = fixture(t);
  const finish = runtime.reserveTask();
  assert.equal(status(), "busy");
  finish();
  finish();
  assert.equal(runtime.admission.pendingCount(), 0);
  assert.equal(status(false), "ready");
  const again = runtime.reserveTask();
  again();
  assert.equal(status(), "ready");
  assert.throws(() => runtime.reserveTask(), /maintenance in progress/);
  runtime.admission.unlock();
  runtime.admission.unlock();
});

test("prompt async tail blocks maintenance after the send request has returned", async (t) => {
  const { inner, session, status } = fixture(t);
  const tail = Promise.withResolvers();
  inner.prompt = () => tail.promise;
  await session.send({ type: "prompt", message: "hello" });
  assert.equal(status(), "busy");
  tail.resolve();
  await turn();
  assert.equal(status(), "ready");
  await assert.rejects(session.send({ type: "prompt", message: "blocked" }), /maintenance in progress/);
  await session.send({ type: "get_tools" });
  await session.send({ type: "abort" });
  await session.send({ type: "extension_ui_response", id: "unused" });
});

test("extension binding and prompt waiting on it count before their first await", async (t) => {
  const { inner, session, status } = fixture(t);
  const binding = Promise.withResolvers();
  inner.bindExtensions = () => binding.promise;
  session.beginExtensionBinding();
  const sending = session.send({ type: "prompt", message: "hello" });
  assert.equal(status(), "busy");
  binding.resolve();
  await sending;
  await turn();
  assert.equal(status(), "ready");
});

test("manual compaction, bash and awaited model commands hold pending reservations", async (t) => {
  for (const type of ["compact", "bash", "set_model"]) {
    const { inner, session, status } = fixture(t);
    const work = Promise.withResolvers();
    inner.compact = () => work.promise;
    inner.executeBash = () => work.promise;
    inner.modelRuntime = { getModel: () => ({ id: "model", provider: "fixture" }) };
    inner.setModel = () => work.promise;
    const sending = session.send({ type, command: "echo fixture" });
    assert.equal(status(), "busy");
    work.resolve();
    await sending;
    assert.equal(status(), "ready");
  }
});

test("title generation counts its readiness and provider await", async (t) => {
  const { session, status } = fixture(t);
  const work = Promise.withResolvers();
  generate = () => work.promise;
  const naming = autoNameRpcSession(session);
  assert.equal(status(), "busy");
  work.reject(new Error("provider failure"));
  await assert.rejects(naming, /provider failure/);
  assert.equal(status(), "ready");
});

test("runtime session flags, queued messages and startup markers block locking", (t) => {
  const { inner, session, runtime, status } = fixture(t);
  for (const key of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"]) {
    inner[key] = key === "pendingMessageCount" ? 1 : true;
    assert.equal(isSessionBusy(session), true, key);
    assert.equal(status(), "busy", key);
    inner[key] = key === "pendingMessageCount" ? 0 : false;
  }
  assert.equal(isSessionBusy(session), false);
  const release = runtime.trackStartingSession(process.cwd());
  assert.equal(runtime.hasBusyTasks(), true);
  assert.equal(status(), "busy");
  release();
  assert.equal(runtime.hasBusyTasks(), false);
});

test("locked admission rejects starting a new session before touching SDK services", async (t) => {
  const { runtime, status } = fixture(t);
  assert.equal(status(), "ready");
  await assert.rejects(runtime.startSession("not-created", "", process.cwd()), /maintenance in progress/);
  assert.equal(runtime.getSession("not-created"), undefined);
  assert.equal(runtime.hasBusyTasks(), false);
});

test("runtime admissions and standalone wrapper fallbacks are independently owned", async (t) => {
  const { inner, runtime } = fixture(t);
  const other = new AgentRuntime();
  assert.equal(runtime.admission.tryLock(), true);
  const releaseOther = other.reserveTask();
  const standalone = new AgentSessionWrapper(inner, { bash: true, powershell: false });
  const releaseStandalone = standalone.reserveTask();
  const second = new AgentSessionWrapper(inner, { bash: true, powershell: false });
  const releaseSecond = second.reserveTask();
  releaseStandalone();
  releaseSecond();
  releaseOther();
  assert.equal(other.admission.pendingCount(), 0);
});

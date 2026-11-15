import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import * as sdk from "@earendil-works/pi-coding-agent";

// 只替换 SDK 创建边界与 shell 探测；断言注册顺序、探测缓存和工具恢复属行为事实。
const calls = [];
let activeToolWrites = 0;
let sessionSeq = 0;

function sessionInner(sessionManager, sessionFile) {
  sessionSeq += 1;
  return {
    // 每次创建必须是新身份，否则 registry 会覆盖上一个会话并遗留 idle 计时器。
    sessionId: `runtime-fixture-${sessionSeq}`,
    sessionFile,
    sessionManager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    agent: { state: {} },
    subscribe: () => () => {},
    getAllTools: () => [{ name: "ext_tool", description: "", sourceInfo: { source: "extension" } }],
    getActiveToolNames: () => [],
    setActiveToolsByName: () => { activeToolWrites += 1; },
    extensionRunner: { emit: async () => {}, setUIContext: () => {} },
    resourceLoader: { getExtensions: () => ({ runtime: { refreshTools: () => {} } }), getSkills: () => ({ skills: [] }) },
    promptTemplates: [],
    dispose() {},
  };
}

const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": {
      ...sdk,
      initTheme() {},
      getShellConfig() { calls.push("bash-probe"); },
      getPowerShellConfig() { calls.push("powershell-probe"); },
      SessionManager: {
        create: (cwd) => ({ getCwd: () => cwd, getSessionFile: () => undefined }),
        open: (file) => ({ getCwd: () => "/", getSessionFile: () => file }),
      },
      createAgentSessionServices: async (options) => { calls.push("services"); return { cwd: options.cwd }; },
      createAgentSessionFromServices: async ({ sessionManager }) => {
        calls.push("session");
        return { session: sessionInner(sessionManager, "/tmp/runtime-fixture.jsonl") };
      },
    },
  },
});
const { AgentRuntime } = await jiti.import("./rpc-manager.ts");

test("a session starts only after its services (extension providers) exist", async (t) => {
  const runtime = new AgentRuntime();
  t.after(() => runtime.drain(100));
  await runtime.startSession("order", "", process.cwd());
  assert.deepEqual(calls.filter((call) => call === "services" || call === "session"), ["services", "session"]);
});

test("shell availability is probed once per runtime, not per session", async (t) => {
  calls.length = 0;
  const runtime = new AgentRuntime();
  t.after(() => runtime.drain(100));
  const first = runtime.getShellAvailability();
  const second = runtime.getShellAvailability();
  assert.equal(first, second);
  assert.deepEqual(calls, ["bash-probe", "powershell-probe"]);

  calls.length = 0;
  new AgentRuntime().getShellAvailability();
  assert.deepEqual(calls, ["bash-probe", "powershell-probe"]);
});

test("restoring a session leaves its tool selection untouched", async (t) => {
  activeToolWrites = 0;
  const runtime = new AgentRuntime();
  t.after(() => runtime.drain(100));

  await runtime.startSession("restored", "/tmp/session.jsonl", process.cwd());
  assert.equal(activeToolWrites, 0, "restoring must not rewrite active tools");

  await runtime.startSession("explicit", "", process.cwd(), ["read"]);
  assert.ok(activeToolWrites > 0, "an explicit tool list must still be applied");
});

test("concurrent starts for one id create a single session", async (t) => {
  const runtime = new AgentRuntime();
  t.after(() => runtime.drain(100));
  const [a, b] = await Promise.all([
    runtime.startSession("shared", "", process.cwd()),
    runtime.startSession("shared", "", process.cwd()),
  ]);
  assert.equal(a.session, b.session);
  assert.equal(runtime.getSession(a.realSessionId), a.session);
});

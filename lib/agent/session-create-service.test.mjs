import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "weclio-create-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
for (const key of Object.keys(process.env)) {
  if (!/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|NODE_TEST_.*)$/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, "agent"),
  APPDATA: join(root, "AppData", "Roaming"), LOCALAPPDATA: join(root, "AppData", "Local"),
  XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"),
  XDG_DATA_HOME: join(root, ".local", "share"), TEMP: root, TMP: root,
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
});
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const jiti = createJiti(import.meta.url);
const { createSession, resumeSession } = await jiti.import("./session-create-service.ts");
const { AgentRuntime } = await jiti.import("../rpc-manager.ts");
const { resolveSessionPath, invalidateSessionListCache } = await jiti.import("../session-reader.ts");
const { readSessionView, readThinkingBlock } = await jiti.import("./session-service.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("creation validates before allocation and applies model/thinking before command", async () => {
  const starts = [];
  const sent = [];
  const runtime = {
    startSession: async (...args) => {
      starts.push(args);
      return { realSessionId: "real-id", session: { send: async (command) => { sent.push(command); return "result"; } } };
    },
  };
  for (const body of [{ cwd, type: "nope" }, { cwd, type: "bash" }, { cwd, type: "ensure_session", toolPreset: "bad" }]) {
    await assert.rejects(createSession(body, runtime));
  }
  assert.equal(starts.length, 0);
  const result = await createSession({ cwd, type: "bash", command: "echo hi", toolNames: ["read"], toolPreset: "none", provider: "fixture", modelId: "m", thinkingLevel: "high" }, runtime);
  assert.deepEqual(result, { success: true, sessionId: "real-id", data: "result" });
  assert.deepEqual(starts[0].slice(1), ["", cwd, ["read"], "none"]);
  assert.deepEqual(sent.map((command) => command.type), ["set_model", "set_thinking_level", "bash"]);
  await createSession({ cwd, type: "ensure_session" }, runtime);
  assert.notEqual(starts[0][0], starts[1][0]);
  assert.equal(sent.length, 3);
});

test("real SDK ensure, shell persistence, lazy thinking and cold restoration", { timeout: 60_000 }, async () => {
  const runtime = new AgentRuntime();
  let cold;
  try {
    const ensured = await createSession({ cwd, type: "ensure_session", toolPreset: "none" }, runtime);
    assert.equal(ensured.data, null);
    assert.ok(ensured.sessionId && !ensured.sessionId.startsWith("__new__"));
    const created = await createSession({ cwd, type: "bash", command: "printf creation-fixture" }, runtime);
    assert.equal(created.data.output, "creation-fixture");
    const file = await resolveSessionPath(created.sessionId);
    assert.ok(file);
    await runtime.drain();
    const manager = SessionManager.open(file);
    const entryId = manager.appendMessage({
      role: "assistant", provider: "fixture", model: "fixture", api: "openai-completions",
      content: [{ type: "thinking", thinking: "isolated thought" }, { type: "text", text: "fixture" }],
      stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    invalidateSessionListCache();
    const view = await readSessionView(created.sessionId, { deferThinking: true });
    assert.equal(JSON.stringify(view.context).includes("isolated thought"), false);
    assert.equal(await readThinkingBlock(created.sessionId, entryId, 0), "isolated thought");
    cold = new AgentRuntime();
    const restored = await resumeSession(created.sessionId, cold);
    assert.equal(restored.sessionId, created.sessionId);
    assert.equal(restored.cwd, cwd);
    assert.equal(restored.inner.sessionManager.getSessionFile(), file);
    assert.ok(restored.inner.sessionManager.getEntries().some((entry) => entry.id === entryId));
    const result = await restored.send({ type: "bash", command: "printf cold-fixture" });
    assert.equal(result.output, "cold-fixture");
    await assert.rejects(resumeSession("missing", cold), (error) => error.code === "session_not_found");
  } finally {
    await runtime.drain();
    if (cold) await cold.drain();
  }
});

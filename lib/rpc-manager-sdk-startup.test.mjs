import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const childFlag = "WECLIO_SDK_STARTUP_FIXTURE";

if (!process.env[childFlag]) {
  test("AgentRuntime integrates with the real SDK in an isolated home", { timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "weclio-sdk-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd)]);

    // 子进程在 SDK import 之前隔离 home/cwd；不继承任何真实凭据或 Pi 配置。
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key)),
    );
    Object.assign(env, {
      [childFlag]: root,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      TEMP: root,
      TMP: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    });
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--test", fileURLToPath(import.meta.url)],
      { cwd, env, timeout: 45000, maxBuffer: 1024 * 1024 },
    ).catch((error) => {
      throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
    });
    t.diagnostic(stdout);
    if (stderr) t.diagnostic(stderr);
  });
} else {
  // SDK 本身不做替换；任何意外网络调用都立即让测试失败。
  const networkAttempts = [];
  const denyNetwork = (...args) => {
    networkAttempts.push(String(args[0]));
    throw new Error("SDK startup fixture must not access the network");
  };
  Socket.prototype.connect = denyNetwork;
  globalThis.fetch = denyNetwork;

  const { createJiti } = await import("jiti");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
  const jiti = createJiti(import.meta.url);
  const { AgentRuntime } = await jiti.import("./rpc-manager.ts");
  const runtime = new AgentRuntime();
  const startRpcSession = (...args) => runtime.startSession(...args);
  const getRpcSession = (id) => runtime.getSession(id);
  const hasBusyRpcSessionForCwd = (cwd) => runtime.hasBusyForCwd(cwd);
  const { trustProject } = await jiti.import("./project-trust.ts");
  const root = process.env[childFlag];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.cwd();
  const model = (id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 512,
  });
  const provider = (id) => ({
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/never-called",
    apiKey: "fixture-only-not-a-credential",
    models: [model(id)],
  });
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { "startup-fallback": provider("fallback") },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "startup-fallback",
    defaultModel: "fallback",
    defaultTools: [],
    packages: [],
  }));

  async function waitForFile(path) {
    const deadline = Date.now() + 5000;
    while (!existsSync(path)) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${path}`);
      await delay(10);
    }
  }

  test("extension provider registration precedes restoration of the saved model", async (t) => {
    const extensionDir = join(agentDir, "extensions");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "provider.js"),
      `export default (pi) => pi.registerProvider("startup-extension", ${JSON.stringify(provider("restored"))});\n`);
    const saved = SessionManager.create(cwd, join(root, "saved-sessions"));
    saved.appendModelChange("startup-extension", "restored");
    saved.appendMessage({ role: "user", content: "Persisted locally; never send to a model", timestamp: Date.now() });
    const sessionFile = saved.getSessionFile();
    assert.ok(existsSync(sessionFile));

    const { session, realSessionId } = await startRpcSession(saved.getSessionId(), sessionFile, cwd);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    assert.equal(session.inner.model?.provider, "startup-extension");
    assert.equal(session.inner.model?.id, "restored");
    assert.equal(session.inner.messages[0].content, "Persisted locally; never send to a model");
    assert.equal(realSessionId, saved.getSessionId());
    assert.equal(getRpcSession(realSessionId), session);
    assert.equal(hasBusyRpcSessionForCwd(cwd), false);
    await session.shutdown();
    assert.equal(getRpcSession(realSessionId), undefined);
    assert.deepEqual(networkAttempts, []);
  });

  test("project factory stays dormant until trust and real startup/shutdown hooks run once", async (t) => {
    const extensionDir = join(cwd, ".pi", "extensions");
    const marker = join(root, "project-events.jsonl");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "probe.js"), `
import { appendFileSync } from "node:fs";
export default (pi) => {
  const record = (event) => appendFileSync(${JSON.stringify(marker)}, JSON.stringify(event) + "\\n");
  record("factory");
  pi.on("session_start", (event) => record(event.type));
  pi.on("session_shutdown", (event) => record(event.type));
};
`);
    assert.equal(existsSync(marker), false);
    const restricted = await startRpcSession("sdk-untrusted", "", cwd);
    t.after(() => restricted.session.shutdown());
    await restricted.session.waitUntilReady();
    assert.equal(existsSync(marker), false);
    await restricted.session.shutdown();
    assert.equal(existsSync(marker), false);
    assert.equal(getRpcSession(restricted.realSessionId), undefined);

    assert.deepEqual(trustProject(cwd, agentDir), { requiresTrust: true, trusted: true });
    const trusted = await startRpcSession("sdk-trusted", "", cwd);
    t.after(() => trusted.session.shutdown());
    await trusted.session.waitUntilReady();
    const events = async () => (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(await events(), ["factory", "session_start"]);
    await Promise.all([trusted.session.shutdown(), trusted.session.shutdown()]);
    assert.deepEqual(await events(), ["factory", "session_start", "session_shutdown"]);
    assert.equal(trusted.session.isAlive(), false);
    assert.equal(getRpcSession(trusted.realSessionId), undefined);
    assert.deepEqual(networkAttempts, []);
  });

  function assertToolsOff(session) {
    assert.deepEqual(session.inner.getActiveToolNames(), []);
    assert.equal(session.inner.systemPrompt, "");
  }

  // 只替换模型流，让真实 Agent run 发出请求并捕获最终 provider 上下文。
  async function captureRequest(session) {
    const agent = session.inner.agent;
    const original = agent.streamFunction;
    let captured;
    agent.streamFunction = (model, context) => {
      captured ??= context;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: "openai-completions",
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "fixture reply" }],
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    try {
      await session.inner.prompt("fixture request while tools are off");
    } finally {
      agent.streamFunction = original;
    }
    assert.ok(captured, "the agent run must issue a model request");
    return captured;
  }

  for (const [name, toolNames, preset] of [
    ["explicit empty toolNames", [], undefined],
    ["none preset", undefined, "none"],
  ]) {
    test(`Tools Off via ${name} starts ready with no tools and an empty prompt`, async (t) => {
      const { session, realSessionId } = await startRpcSession(`sdk-off-${name}`, "", cwd, toolNames, preset);
      t.after(() => session.shutdown());
      await session.waitUntilReady();
      assertToolsOff(session);
      assert.equal(getRpcSession(realSessionId), session);
      assert.equal(hasBusyRpcSessionForCwd(cwd), false);
      // 保留 SDK 的真实 getter，避免可写 fixture 掩盖不兼容赋值。
      assert.equal(Object.getOwnPropertyDescriptor(session.inner.agent.state, "systemPrompt").set, undefined);
      await session.shutdown();
      assert.equal(getRpcSession(realSessionId), undefined);
      assert.deepEqual(networkAttempts, []);
    });
  }

  test("Tools Off can enable read and return to Off without losing the normal prompt", async (t) => {
    const { session } = await startRpcSession("sdk-off-toggle", "", cwd, []);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    assertToolsOff(session);

    await session.send({ type: "set_tools", toolNames: ["read"] });
    assert.deepEqual(session.inner.getActiveToolNames(), ["read"]);
    const normalPrompt = session.inner.systemPrompt;
    assert.notEqual(normalPrompt, "");

    await session.send({ type: "set_tools", toolNames: [] });
    assertToolsOff(session);
    await session.send({ type: "set_tools", preset: "default" });
    assert.ok(session.inner.getActiveToolNames().includes("read"));
    assert.notEqual(session.inner.systemPrompt, "");
    await session.send({ type: "set_tools", preset: "none" });
    assertToolsOff(session);
    await session.send({ type: "set_tools", toolNames: ["read"] });
    assert.equal(session.inner.systemPrompt, normalPrompt);
    assert.deepEqual(networkAttempts, []);
  });

  test("Pi rejects a busy reload without losing extension UI; a real reload replaces it", async (t) => {
    const extensionPath = join(agentDir, "extensions", "reload-ui.js");
    t.after(() => rm(extensionPath, { force: true }));
    const writeExtension = (key) => writeFile(extensionPath, `
export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(${JSON.stringify(key)}, "ready");
    ctx.ui.setWidget(${JSON.stringify(key)}, ["widget"]);
  });
};
`);
    await writeExtension("old");
    const { session } = await startRpcSession("sdk-reload-ui", "", cwd);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    const events = [];
    const { openSessionEventStream } = await jiti.import("./agent/session-events.ts");
    const eventStream = openSessionEventStream(session, (event) => events.push(event), { heartbeatMs: 0 });
    t.after(() => eventStream.close());
    const assertExtensionUI = async (key) => {
      const state = await session.send({ type: "get_state" });
      assert.deepEqual(state.extensionStatuses, [{ key, text: "ready" }]);
      assert.deepEqual(state.extensionWidgets.map((widget) => widget.key), [key]);
    };
    const reloadEvents = () => events.filter((event) => event.type === "session_reloaded");
    await assertExtensionUI("old");

    const agent = session.inner.agent;
    const originalStream = agent.streamFunction;
    const stream = createAssistantMessageEventStream();
    const entered = Promise.withResolvers();
    agent.streamFunction = (model) => {
      entered.resolve(model);
      return stream;
    };
    const running = session.inner.prompt("keep the session busy without the network");
    const model = await entered.promise;
    try {
      assert.equal(session.inner.isStreaming, true);
      await assert.rejects(session.send({ type: "reload" }), /Wait for the current response/);
      await assertExtensionUI("old");
      await assert.rejects(session.inner.extensionRunner.createCommandContext().reload(), /Wait for the current response/);
      await assertExtensionUI("old");
      assert.equal(reloadEvents().length, 0);
    } finally {
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "fixture reply" }],
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      await running;
      agent.streamFunction = originalStream;
    }

    await writeExtension("direct");
    assert.deepEqual(await session.send({ type: "reload" }), { success: true });
    await assertExtensionUI("direct");
    assert.equal(reloadEvents().length, 1);
    await writeExtension("command");
    await session.inner.extensionRunner.createCommandContext().reload();
    await assertExtensionUI("command");
    assert.equal(reloadEvents().length, 2);
    assert.deepEqual(networkAttempts, []);
  });

  test("Tools Off survives RPC reload and can still enable read", async (t) => {
    const { session } = await startRpcSession("sdk-off-rpc-reload", "", cwd, ["read"]);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    await session.send({ type: "set_tools", toolNames: [] });
    assertToolsOff(session);

    // reload 会激活新加入 defaultTools 的工具；Off 必须再次收窄 active set。
    const settingsPath = join(agentDir, "settings.json");
    const originalSettings = await readFile(settingsPath, "utf8");
    t.after(() => writeFile(settingsPath, originalSettings));
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), defaultTools: ["read"] }));
    assert.deepEqual(await session.send({ type: "reload" }), { success: true });
    assertToolsOff(session);
    await session.send({ type: "set_tools", toolNames: ["read"] });
    assert.deepEqual(session.inner.getActiveToolNames(), ["read"]);
    assert.notEqual(session.inner.systemPrompt, "");
    assert.deepEqual(networkAttempts, []);
  });

  test("Tools Off survives extension-command context.reload and can still enable read", async (t) => {
    const extensionPath = join(agentDir, "extensions", "reload-command.js");
    const marker = join(root, "command-reloaded");
    t.after(() => rm(extensionPath, { force: true }));
    await writeFile(extensionPath, `
import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.registerCommand("fixture-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
      writeFileSync(${JSON.stringify(marker)}, "reloaded");
    },
  });
};
`);
    const { session } = await startRpcSession("sdk-off-command-reload", "", cwd, ["read"]);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    await session.send({ type: "set_tools", preset: "none" });
    assertToolsOff(session);

    // SDK 自己分发临时 slash command；不进入模型请求，也不构造伪 command context。
    await session.inner.prompt("/fixture-reload");
    assert.equal(await readFile(marker, "utf8"), "reloaded");
    assertToolsOff(session);
    await session.send({ type: "set_tools", toolNames: ["read"] });
    assert.deepEqual(session.inner.getActiveToolNames(), ["read"]);
    assert.notEqual(session.inner.systemPrompt, "");
    assert.deepEqual(networkAttempts, []);
  });

  for (const [name, toolNames, preset, reloadCommand] of [
    ["empty-list", [], undefined, undefined],
    ["none-preset", undefined, "none", "/fixture-late-reload"],
  ]) {
    test(`Tools Off via ${name} survives late defaultActive tool registration before and after reload`, async (t) => {
      const extensionPath = join(agentDir, "extensions", `late-tool-${name}.js`);
      const snapshot = join(root, `late-tool-${name}.json`);
      t.after(() => rm(extensionPath, { force: true }));
      await writeFile(extensionPath, `
import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.registerCommand("fixture-late-tool", {
    handler: async (args, ctx) => {
      pi.registerTool({
        name: args.trim(),
        label: "Late fixture tool",
        description: "Locally registered fixture; never calls a model",
        promptSnippet: "A late fixture tool",
        defaultActive: true,
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
      });
      writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify({ tools: pi.getActiveTools(), systemPrompt: ctx.getSystemPrompt() }));
    },
  });
  pi.registerCommand("fixture-late-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
};
`);
      const { session } = await startRpcSession(`sdk-off-late-${name}`, "", cwd, toolNames, preset);
      t.after(() => session.shutdown());
      await session.waitUntilReady();
      assertToolsOff(session);

      const register = async (toolName) => {
        await session.inner.prompt(`/fixture-late-tool ${toolName}`);
        assert.ok(session.inner.getAllTools().some((tool) => tool.name === toolName));
        return JSON.parse(await readFile(snapshot, "utf8"));
      };
      // 命令内部在 registerTool 返回后立即取快照，验证同步 refresh 而非事后补救。
      assert.deepEqual(await register("fixture_late_before_reload"), { tools: [], systemPrompt: "" });
      assertToolsOff(session);
      // 真实请求不得带上 late tool 或其提示。
      const beforeRequest = await captureRequest(session);
      assert.equal(getCurrentSystemPrompt(beforeRequest.messages), "");
      assert.deepEqual(getCurrentTools(beforeRequest.messages), []);
      assertToolsOff(session);

      if (reloadCommand) await session.inner.prompt(reloadCommand);
      else await session.send({ type: "reload" });
      assertToolsOff(session);
      assert.deepEqual(await register("fixture_late_after_reload"), { tools: [], systemPrompt: "" });
      assertToolsOff(session);
      const afterRequest = await captureRequest(session);
      assert.equal(getCurrentSystemPrompt(afterRequest.messages), "");
      assert.deepEqual(getCurrentTools(afterRequest.messages), []);
      assertToolsOff(session);

      await session.send({ type: "set_tools", toolNames: ["read"] });
      assert.deepEqual(new Set(session.inner.getActiveToolNames()), new Set(["read", "fixture_late_after_reload"]));
      assert.ok(session.inner.getCallableToolNames().includes("fixture_late_after_reload"));
      assert.notEqual(session.inner.systemPrompt, "");
      // 同一捕获手段在 On 时必须能看到真实提示与工具，证明先前空请求不是假阳性。
      const enabledRequest = await captureRequest(session);
      assert.notEqual(getCurrentSystemPrompt(enabledRequest.messages), "");
      assert.deepEqual(
        new Set(getCurrentTools(enabledRequest.messages).map((tool) => tool.name)),
        new Set(["read", "fixture_late_after_reload"]),
      );
      // On 后再次注册，原 SDK callback 仍须正常激活新工具，不能沿用陈旧 Off 状态。
      const onSnapshot = await register("fixture_late_while_on");
      assert.deepEqual(new Set(onSnapshot.tools), new Set(["read", "fixture_late_after_reload", "fixture_late_while_on"]));
      assert.notEqual(onSnapshot.systemPrompt, "");
      assert.deepEqual(networkAttempts, []);
    });
  }

  test("readiness waits for actual session_start and shutdown cleans up after binding", async (t) => {
    const extensionDir = join(agentDir, "extensions");
    const entered = join(root, "binding-entered");
    const release = join(root, "binding-release");
    const completed = join(root, "binding-completed");
    const shutdown = join(root, "binding-shutdown");
    await writeFile(join(extensionDir, "readiness.js"), `
import { existsSync, writeFileSync } from "node:fs";
export default (pi) => {
  pi.on("session_start", async () => {
    writeFileSync(${JSON.stringify(entered)}, "entered");
    while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(${JSON.stringify(completed)}, "completed");
  });
  pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(shutdown)}, String(existsSync(${JSON.stringify(completed)}))));
};
`);
    let session;
    t.after(async () => {
      await writeFile(release, "release");
      await session?.shutdown();
    });
    const started = await startRpcSession("sdk-readiness", "", cwd);
    session = started.session;
    await waitForFile(entered);
    let ready = false;
    const readiness = session.waitUntilReady().then(() => { ready = true; });
    let stopped = false;
    const stopping = session.shutdown().then(() => { stopped = true; });
    await delay(20);
    assert.equal(ready, false);
    assert.equal(stopped, false);
    assert.equal(existsSync(shutdown), false);
    assert.equal(getRpcSession(started.realSessionId), session);
    assert.equal(runtime.admission.isBusy(() => runtime.hasBusyTasks()), true);

    await writeFile(release, "release");
    await Promise.all([readiness, stopping]);
    assert.equal(await readFile(shutdown, "utf8"), "true");
    assert.equal(getRpcSession(started.realSessionId), undefined);
    assert.equal(session.isAlive(), false);
    assert.equal(hasBusyRpcSessionForCwd(cwd), false);
    assert.equal(runtime.admission.isBusy(() => runtime.hasBusyTasks()), false);
    assert.deepEqual(networkAttempts, []);
  });
}

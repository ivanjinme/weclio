import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const childFlag = "WECLIO_SDK_PERSISTENCE_FIXTURE";

if (!process.env[childFlag]) {
  test("session persistence and forks use the real SDK in an isolated home", { timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "weclio-sdk-persistence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd)]);
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
  // 在 SDK 加载前隔离网络；模型流只由本地可控 fixture 提供。
  const networkAttempts = [];
  const denyNetwork = () => {
    networkAttempts.push("unexpected network access");
    throw new Error("Persistence fixture must not access the network");
  };
  Socket.prototype.connect = denyNetwork;
  globalThis.fetch = denyNetwork;

  const { createJiti } = await import("jiti");
  const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const root = process.env[childFlag];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.cwd();
  const provider = "persistence-fixture";
  const modelId = "offline-model";
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/never-called",
        apiKey: "fixture-only-not-a-credential",
        models: [{
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 512,
        }],
      },
    },
  }));

  function assistantMessage(text, stopReason = "stop") {
    return {
      role: "assistant",
      api: "openai-completions",
      provider,
      model: modelId,
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      ...(stopReason === "error" ? { errorMessage: "fixture model failure" } : {}),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    };
  }

  async function fixture(t, setup = () => {}) {
    const directory = await mkdtemp(join(root, "session-"));
    const manager = SessionManager.create(cwd, join(directory, "sessions"));
    setup(manager);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: provider,
      defaultModel: modelId,
      defaultTools: ["read"],
      packages: [],
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
    });
    const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager });
    const wrapper = new AgentSessionWrapper(inner, { bash: true, powershell: false });
    t.after(() => wrapper.shutdown());
    wrapper.start();
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    return { wrapper, inner, manager, file: manager.getSessionFile() };
  }

  function nextReply(inner) {
    const entered = Promise.withResolvers();
    inner.agent.streamFunction = (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("");
      stream.push({ type: "start", partial: message });
      const finish = (text = "fixture answer", reason = "stop") => {
        Object.assign(message, assistantMessage(text, reason));
        stream.push(reason === "stop"
          ? { type: "done", reason, message }
          : { type: "error", reason, error: message });
      };
      options?.signal?.addEventListener("abort", () => finish("", "aborted"), { once: true });
      entered.resolve({ context, finish });
      return stream;
    };
    return entered.promise;
  }

  function promptDone(wrapper) {
    return new Promise((resolve) => {
      const unsubscribe = wrapper.onEvent((event) => {
        if (event.type !== "prompt_done") return;
        unsubscribe();
        resolve();
      });
    });
  }

  async function persistedEntries(file) {
    return (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  }

  test("creating and binding a session alone does not create a transcript", async (t) => {
    const { wrapper, file } = await fixture(t);
    assert.equal(existsSync(file), false);
    await wrapper.shutdown();
    assert.equal(existsSync(file), false);
  });

  test("the first user prompt is persisted before its assistant reply and appends once", async (t) => {
    const { wrapper, inner, manager, file } = await fixture(t);
    const reply = nextReply(inner);
    const settled = promptDone(wrapper);
    await wrapper.send({ type: "prompt", message: "first pending prompt" });
    const request = await reply;
    const before = await persistedEntries(file);
    assert.equal(before[0].id, manager.getSessionId());
    assert.equal(before.some((entry) => entry.message?.role === "user"), true);
    assert.equal(before.some((entry) => entry.message?.role === "assistant"), false);
    assert.equal(wrapper.isRunning(), true);
    request.finish();
    await settled;
    const after = await persistedEntries(file);
    assert.equal(after.filter((entry) => entry.type === "session").length, 1);
    assert.equal(after.filter((entry) => entry.message?.role === "user").length, 1);
    assert.equal(after.filter((entry) => entry.message?.role === "assistant").length, 1);
    const reopened = SessionManager.open(file);
    assert.equal(reopened.getSessionId(), manager.getSessionId());
    assert.deepEqual(reopened.getEntries(), manager.getEntries());
  });

  test("failed first-prompt persistence leaves the session idle and retryable", async (t) => {
    const { wrapper, inner, file } = await fixture(t);
    const directory = dirname(file);
    await rm(directory, { recursive: true });

    await assert.rejects(wrapper.send({ type: "prompt", message: "not persisted" }), { code: "ENOENT" });
    assert.equal(wrapper.isRunning(), false);
    assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
    assert.deepEqual(inner.messages, []);

    await mkdir(directory);
    const reply = nextReply(inner);
    const settled = promptDone(wrapper);
    await wrapper.send({ type: "prompt", message: "retry" });
    (await reply).finish();
    await settled;
    const entries = await persistedEntries(file);
    const users = entries.filter((entry) => entry.message?.role === "user");
    assert.deepEqual(users.map((entry) => entry.message.content), [[{ type: "text", text: "retry" }]]);
  });

  test("Tools Off reaches actual requests without historical system prompts or tools", async (t) => {
    const { wrapper, inner } = await fixture(t);
    for (const preset of ["default", "none", "default"]) {
      await wrapper.send({ type: "set_tools", preset });
      const off = preset === "none";
      const state = await wrapper.send({ type: "get_state" });
      assert.equal(state.systemPrompt === "", off);
      const reply = nextReply(inner);
      const settled = promptDone(wrapper);
      await wrapper.send({ type: "prompt", message: `request with ${preset} tools` });
      const request = await reply;
      assert.equal(getCurrentSystemPrompt(request.context.messages) === "", off);
      assert.equal(getCurrentTools(request.context.messages).length === 0, off);
      request.finish();
      await settled;
    }
    assert.deepEqual(networkAttempts, []);
  });

  test("early persistence keeps a reset leaf and abandoned setup entries intact", async (t) => {
    const { wrapper, inner, manager, file } = await fixture(t);
    const abandoned = manager.appendCustomEntry("abandoned-setup", { retained: true });
    manager.resetLeaf();
    const reply = nextReply(inner);
    const settled = promptDone(wrapper);
    await wrapper.send({ type: "prompt", message: "new root prompt" });
    const request = await reply;
    const user = manager.getEntries().find((entry) => entry.message?.role === "user");
    assert.ok(user);
    assert.equal(manager.getBranch(user.id).some((entry) => entry.id === abandoned), false);
    assert.equal(manager.getEntries().some((entry) => entry.id === abandoned), true);
    request.finish();
    await settled;
    assert.equal(SessionManager.open(file).getEntries().some((entry) => entry.id === abandoned), true);
  });

  for (const reason of ["error", "aborted"]) {
    test(`the first ${reason} reply keeps the user prompt recoverable`, async (t) => {
      const { wrapper, inner, manager, file } = await fixture(t);
      const reply = nextReply(inner);
      const settled = promptDone(wrapper);
      await wrapper.send({ type: "prompt", message: `first ${reason} prompt` });
      const request = await reply;
      if (reason === "aborted") await wrapper.send({ type: "abort" });
      else request.finish("", reason);
      await settled;
      assert.equal(wrapper.isRunning(), false);
      const reopened = SessionManager.open(file);
      assert.equal(reopened.getSessionId(), manager.getSessionId());
      const messages = reopened.getEntries().filter((entry) => entry.type === "message");
      assert.equal(messages.filter((entry) => entry.message.role === "user").length, 1);
      assert.equal(messages.at(-1).message.stopReason, reason);
    });
  }

  test("shell-only history survives reopening and later messages append without a second header", async (t) => {
    const { wrapper, manager, file } = await fixture(t);
    const first = await wrapper.send({ type: "bash", command: "printf first-shell" });
    assert.equal(first.exitCode, 0);
    assert.equal(first.output, "first-shell");
    const id = manager.getSessionId();
    assert.equal(SessionManager.open(file).getSessionId(), id);
    const second = await wrapper.send({ type: "bash", command: "printf second-shell" });
    assert.equal(second.output, "second-shell");
    manager.appendMessage({ role: "user", content: "after shell", timestamp: Date.now() });
    const entries = await persistedEntries(file);
    assert.equal(entries.filter((entry) => entry.type === "session").length, 1);
    assert.deepEqual(entries.filter((entry) => entry.message?.role === "bashExecution").map((entry) => entry.message.output), ["first-shell", "second-shell"]);
    // JSONL 不保存 undefined 可选属性，比较实际可持久化的完整记录。
    assert.deepEqual(SessionManager.open(file).getEntries(), JSON.parse(JSON.stringify(manager.getEntries())));
    assert.equal(manager.getSessionId(), id);
  });

  for (const withSetup of [false, true]) {
    test(`fork before the first user keeps ${withSetup ? "setup entries" : "an empty branch"}, identity, and lineage`, async (t) => {
      let userId;
      const { wrapper, manager, file } = await fixture(t, (source) => {
        if (withSetup) {
          source.appendModelChange(provider, modelId);
          source.appendThinkingLevelChange("off");
        }
        userId = source.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
      });
      const original = await readFile(file, "utf8");
      const expected = withSetup ? manager.getBranch(userId).slice(0, -1) : [];
      const result = await wrapper.send({ type: "fork", entryId: userId });
      assert.equal(result.cancelled, false);
      assert.notEqual(result.newSessionId, manager.getSessionId());
      const forkFile = await resolveSessionPath(result.newSessionId);
      assert.ok(forkFile && existsSync(forkFile), "the returned fork must be recoverable from disk");
      const fork = SessionManager.open(forkFile);
      assert.equal(fork.getSessionId(), result.newSessionId);
      assert.ok(basename(forkFile).endsWith(`_${result.newSessionId}.jsonl`));
      assert.equal(fork.getHeader().parentSession, file);
      assert.equal(fork.getCwd(), cwd);
      assert.deepEqual(fork.getEntries(), expected);
      fork.appendMessage({ role: "user", content: "new branch prompt", timestamp: Date.now() });
      assert.equal(SessionManager.open(forkFile).getSessionId(), result.newSessionId);
      assert.equal(await readFile(file, "utf8"), original);
      assert.equal(wrapper.isAlive(), false);
    });
  }

  test("fork including an assistant preserves selected entry IDs without rewriting the source", async (t) => {
    let assistantId;
    const { wrapper, manager, file } = await fixture(t, (source) => {
      source.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
      assistantId = source.appendMessage(assistantMessage("selected answer"));
      source.appendMessage({ role: "user", content: "excluded later prompt", timestamp: Date.now() });
    });
    const original = await readFile(file, "utf8");
    const expected = manager.getBranch(assistantId);
    const result = await wrapper.send({ type: "fork", entryId: assistantId, includeEntry: true });
    assert.equal(result.cancelled, false);
    const forkFile = await resolveSessionPath(result.newSessionId);
    assert.ok(forkFile && existsSync(forkFile));
    const fork = SessionManager.open(forkFile);
    assert.equal(fork.getSessionId(), result.newSessionId);
    assert.equal(fork.getHeader().parentSession, file);
    assert.deepEqual(fork.getEntries(), expected);
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(networkAttempts, []);
  });
}

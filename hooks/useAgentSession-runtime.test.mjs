import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// 保留 hook 状态和 ref，仅替换 React 调度与网络边界；执行真实的草稿操作链。
function createHookState({ runEffects = false } = {}) {
  const cells = [];
  const effects = [];
  let cursor = 0;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memoize = (fn, deps) => {
    const index = cursor++;
    if (!sameDeps(cells[index]?.deps, deps)) cells[index] = { value: fn(), deps };
    return cells[index].value;
  };
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
    return [cells[index], (value) => {
      cells[index] = typeof value === "function" ? value(cells[index]) : value;
    }];
  };
  return {
    reset() { cursor = 0; },
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    cleanup() { for (const cell of cells) cell?.cleanup?.(); },
    react: {
      useState,
      useRef(initial) { return useState(() => ({ current: initial }))[0]; },
      useReducer(reducer, initial) {
        const [value, setValue] = useState(initial);
        return [value, (action) => setValue((state) => reducer(state, action))];
      },
      useCallback(fn, deps) { return memoize(() => fn, deps); },
      useMemo: memoize,
      useEffect(fn, deps) {
        if (!runEffects) return;
        const index = cursor++;
        const previous = cells[index];
        if (sameDeps(previous?.deps, deps)) return;
        const cell = { deps };
        cells[index] = cell;
        effects.push(() => { previous?.cleanup?.(); cell.cleanup = fn(); });
      },
    },
  };
}

test("autocomplete-created drafts preserve thinking through first send and subsequent model changes", async (t) => {
  const hooks = createHookState();
  const commands = [];
  let runtimeThinking = "high";
  let creationCount = 0;
  const apiBase = await createJiti(import.meta.url).import("../lib/api-base.ts");
  apiBase.configureApiBase({ basePath: "/v1" });
  t.after(apiBase.resetApiBase);
  const jiti = createJiti(import.meta.url, {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/api-base": apiBase,
      "@/lib/api-fetch": { apiFetch: (path, init) => globalThis.fetch(apiBase.apiUrl(path), init) },
      "@/lib/event-stream": {
        // 事件流改成 fetch 实现后，用替身把连接交回测试里的 EventSource。
        EVENT_STREAM_CONNECTING: 0,
        EVENT_STREAM_OPEN: 1,
        EVENT_STREAM_CLOSED: 2,
        createEventStream: (url) => new globalThis.EventSource(url),
      },
      "@/lib/agent-client": {
        getDefaultAgentClient: () => ({ routes: { events: (id) => "/v1/sessions/" + id + "/events", runningEvents: () => "/v1/events", commands: (id) => "/v1/sessions/" + id + "/commands", state: (id) => "/v1/sessions/" + id + "/state" } }),
        async sendAgentCommand(_sid, command) {
          commands.push(command);
          // SDK setModel() 会重新应用保存的默认推理档位。
          if (command.type === "set_model") runtimeThinking = "high";
          if (command.type === "set_thinking_level") runtimeThinking = command.level;
          if (command.type === "prompt") assert.equal(runtimeThinking, "medium");
          return command.type === "get_commands" ? { commands: [] } : null;
        },
      },
    },
  });
  const { useAgentSession: runSessionHook } = await jiti.import("./useAgentSession.ts");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/v1/sessions");
    const body = JSON.parse(options.body);
    assert.equal(body.thinkingLevel, "medium");
    assert.equal(body.modelId, "first-model");
    runtimeThinking = body.thinkingLevel;
    creationCount++;
    return Response.json({ sessionId: "draft-session" });
  });
  class EventSourceStub {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "connected" }) }));
    }
    close() {}
  }
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = EventSourceStub;
  t.after(() => {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  });
  const renderDraft = () => {
    hooks.reset();
    return runSessionHook({ session: null, newSessionCwd: process.cwd(), resolveNewSessionCwd: async () => process.cwd() });
  };

  let draft = renderDraft();
  await draft.handleModelChange("provider", "first-model");
  draft = renderDraft();
  await draft.loadSlashCommands();
  draft = renderDraft();
  assert.equal(await draft.handleSend("Hello"), true);
  assert.equal(runtimeThinking, "medium");
  assert.equal(creationCount, 1);
  assert.deepEqual(commands.map((command) => command.type), ["get_commands", "set_model", "set_thinking_level", "prompt"]);

  // 换模型后仍须重新应用草稿选择，不能被 SDK 的 high 默认值覆盖。
  await draft.handleModelChange("provider", "second-model");
  assert.equal(runtimeThinking, "medium");
  assert.deepEqual(commands.slice(-2).map((command) => command.type), ["set_model", "set_thinking_level"]);
});

test("all send paths carry skill parts without treating tagged input as a shell command", async (t) => {
  const hooks = createHookState();
  const commands = [];
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/event-stream": {
        // 事件流改成 fetch 实现后，用替身把连接交回测试里的 EventSource。
        EVENT_STREAM_CONNECTING: 0,
        EVENT_STREAM_OPEN: 1,
        EVENT_STREAM_CLOSED: 2,
        createEventStream: (url) => new globalThis.EventSource(url),
      },
      "@/lib/agent-client": {
        getDefaultAgentClient: () => ({ routes: { events: (id) => "/v1/sessions/" + id + "/events", runningEvents: () => "/v1/events", commands: (id) => "/v1/sessions/" + id + "/commands", state: (id) => "/v1/sessions/" + id + "/state" } }),
        async sendAgentCommand(_sid, command) { commands.push(command); return null; },
      },
    },
  });
  const { useAgentSession } = await jiti.import("./useAgentSession.ts");
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = class {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "connected" }) }));
    }
    close() {}
  };
  t.after(() => {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  });
  const hook = useAgentSession({ session: { id: "skill-session", cwd: process.cwd() } });
  const parts = [{ type: "text", text: "! note " }, { type: "skill", name: "design" }];
  const message = "! note /skill:design";
  await hook.handleSteer(message, undefined, parts);
  await hook.handleFollowUp(message, undefined, parts);
  await hook.handlePromptWithStreamingBehavior(message, "followUp", undefined, parts);
  assert.equal(await hook.handleSend(message, undefined, parts), true);
  assert.deepEqual(commands.map((command) => command.type), ["steer", "follow_up", "prompt", "prompt"]);
  for (const command of commands) {
    assert.deepEqual(command.parts, parts);
    assert.equal(command.message, message);
  }
});

async function mountExistingSession(t, { apiFetch, sendAgentCommand, runEffects = true, virtualModules = {} }) {
  const hooks = createHookState({ runEffects });
  const streams = [];
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/api-base": { apiUrl: (path) => path },
      "@/lib/api-fetch": { apiFetch },
      "@/lib/event-stream": {
        EVENT_STREAM_OPEN: 1,
        EVENT_STREAM_CLOSED: 2,
        createEventStream() {
          const stream = {
            readyState: 1,
            close() { this.readyState = 2; },
            emit(event) { this.onmessage({ data: JSON.stringify(event) }); },
          };
          streams.push(stream);
          queueMicrotask(() => stream.emit({ type: "connected", isStreaming: false }));
          return stream;
        },
      },
      "@/lib/agent-client": {
        getDefaultAgentClient: () => ({ routes: { events: (id) => `/sessions/${id}/events` } }),
        sendAgentCommand,
      },
      ...virtualModules,
    },
  });
  const { useAgentSession: runSessionHook } = await jiti.import("./useAgentSession.ts");
  const session = { id: "existing-session", cwd: process.cwd() };
  const render = () => {
    hooks.reset();
    const result = runSessionHook({ session, newSessionCwd: null });
    hooks.flushEffects();
    return result;
  };
  t.after(() => hooks.cleanup());
  return { render, streams, cleanup: hooks.cleanup };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function stubRecoveryEvents(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
}

for (const completion of ["SSE", "polling"]) {
  test(`mounted manual compaction recovers via ${completion} without a prompt run`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let isCompacting = true;
    const requests = [];
    const legacyTree = [{ entry: { id: "leaf", type: "message", message: { role: "assistant", content: [{ type: "text", text: "legacy" }] } }, children: [] }];
    const transcript = Promise.withResolvers();
    const liveState = Promise.withResolvers();
    const { render, streams } = await mountExistingSession(t, {
      async apiFetch(url) {
        const path = url.split("?")[0];
        requests.push(path);
        if (path.endsWith("/state") && !isCompacting) return liveState.promise;
        if (path.endsWith("/state") || path === "/agent/existing-session") {
          return Response.json({ running: true, state: { isCompacting, isStreaming: false, isPromptRunning: false, contextUsage: { percent: isCompacting ? 85 : 30 } } });
        }
        if (path === "/sessions/existing-session") {
          assert.equal(new URLSearchParams(url.split("?")[1]).get("tree"), "preview");
          if (!isCompacting) return transcript.promise;
          return Response.json({ tree: legacyTree, leafId: "leaf", context: { messages: [], entryIds: [] } });
        }
        assert.equal(path, "/models");
        return Response.json({ models: [] });
      },
      async sendAgentCommand() { return null; },
    });
    stubRecoveryEvents(t);
    render();
    await settle();
    let hook = render();
    assert.deepEqual(hook.data.tree, legacyTree);
    assert.equal(hook.isCompacting, true);
    assert.equal(hook.agentRunning, false);
    assert.equal(streams.length, 1);
    assert.equal(await hook.handleSend("blocked"), false);

    if (completion === "polling") {
      const stream = streams[0];
      stream.close();
      stream.onerror();
      t.mock.timers.tick(15_000);
      await settle();
      assert.equal(render().isCompacting, true);
    }
    isCompacting = false;
    if (completion === "SSE") streams[0].emit({ type: "compaction_end", reason: "manual" });
    else t.mock.timers.tick(15_000);
    await settle();
    hook = render();
    assert.equal(hook.isCompacting, true);
    assert.equal(await hook.handleSend("blocked during transcript reload"), false);
    window.dispatchEvent(new Event("online"));
    if (completion === "SSE") streams[0].emit({ type: "compaction_end", reason: "manual" });
    await settle();
    assert.equal(requests.filter((path) => path === "/sessions/existing-session").length, 2);

    const compactedMessage = { role: "user", content: "persisted", timestamp: 1 };
    transcript.resolve(Response.json({ leafId: null, context: { messages: [compactedMessage], entryIds: [] } }));
    await settle();
    hook = render();
    assert.deepEqual(hook.messages, [compactedMessage]);
    assert.equal(await hook.handleSend("blocked during state reload"), false);
    liveState.resolve(Response.json({ running: true, state: { isCompacting: false, contextUsage: { percent: 30 } } }));
    await settle();
    hook = render();
    assert.equal(hook.isCompacting, false);
    assert.equal(hook.contextUsage.percent, 30);
    assert.equal(await hook.handleSend("usable again"), true);
    assert.deepEqual(render().messages.map(({ content }) => content), ["persisted", "usable again"]);
    assert.equal(requests.filter((path) => path === "/agent/existing-session").length, completion === "polling" ? 2 : 0);
  });
}

for (const supersededBy of ["cleanup", "new prompt"]) {
  test(`late mount state cannot open a stream after ${supersededBy}`, async (t) => {
    const liveState = Promise.withResolvers();
    const commands = [];
    let stateRequested = false;
    const { render, streams, cleanup } = await mountExistingSession(t, {
      async apiFetch(url) {
        if (url.endsWith("/state")) {
          stateRequested = true;
          return liveState.promise;
        }
        if (url.startsWith("/sessions/existing-session?")) {
          return Response.json({ leafId: null, context: { messages: [], entryIds: [] } });
        }
        return Response.json({ models: [] });
      },
      async sendAgentCommand(_sid, command) { commands.push(command.type); return null; },
    });
    stubRecoveryEvents(t);
    render();
    await settle();
    assert.equal(stateRequested, true);

    if (supersededBy === "cleanup") cleanup();
    else assert.equal(await render().handleSend("new prompt"), true);
    liveState.resolve(Response.json({ running: true, state: { isCompacting: true, isStreaming: false, isPromptRunning: false } }));
    await settle();

    if (supersededBy === "cleanup") {
      assert.equal(streams.length, 0);
      assert.deepEqual(commands, []);
    } else {
      assert.equal(streams.length, 1);
      assert.equal(streams[0].readyState, 1);
      assert.deepEqual(commands, ["prompt"]);
      const hook = render();
      assert.equal(hook.isCompacting, false);
      assert.deepEqual(hook.messages.map(({ content }) => content), ["new prompt"]);
    }
  });
}

test("a compaction event reload cannot overwrite a newer prompt on another stream", async (t) => {
  const transcript = Promise.withResolvers();
  const storedMessage = { role: "user", content: "first prompt", timestamp: 1 };
  let reloadingCompaction = false;
  const { render, streams } = await mountExistingSession(t, {
    runEffects: false,
    async apiFetch(url) {
      assert.match(url, /^\/sessions\/existing-session\?/);
      if (reloadingCompaction) return transcript.promise;
      return Response.json({ leafId: null, context: { messages: [storedMessage], entryIds: [] } });
    },
    async sendAgentCommand() { return null; },
  });
  assert.equal(await render().handleSend("first prompt"), true);
  streams[0].emit({ type: "prompt_done" });
  await settle();
  assert.equal(render().agentRunning, false);

  streams[0].emit({ type: "compaction_start" });
  reloadingCompaction = true;
  streams[0].emit({ type: "compaction_end", reason: "manual" });
  assert.equal(await render().handleSend("next prompt"), true);
  transcript.resolve(Response.json({ leafId: null, context: { messages: [storedMessage], entryIds: [] } }));
  await settle();
  assert.deepEqual(render().messages.map(({ content }) => content), ["first prompt", "next prompt"]);
});

test("edited messages stay prompts after losing their attachments and can be image-only", async (t) => {
  const { parseAgentCommand } = await createJiti(import.meta.url).import("../lib/agent/protocol/validate.ts");
  const image = { data: "AA==", mimeType: "image/png" };
  for (const [message, images] of [["!example", undefined], ["", [image]]]) {
    const commands = [];
    const { render } = await mountExistingSession(t, {
      runEffects: false,
      apiFetch: async () => Response.json({ context: { messages: [], entryIds: [] } }),
      async sendAgentCommand(_sid, command) {
        commands.push(parseAgentCommand(command));
        return command.type === "navigate_before" ? { targetId: "parent" } : null;
      },
    });
    await render().handleEditFromHere("edited-entry", message, images);
    assert.deepEqual(commands, [
      { type: "navigate_before", entryId: "edited-entry" },
      { type: "prompt", message, ...(images ? { images: [{ type: "image", ...image }] } : {}) },
    ]);
  }
});

test("connected prompt rejects roll back the optimistic bubble, unlike transport failures", async (t) => {
  const jiti = createJiti(import.meta.url);
  const { createAgentClient } = await jiti.import("../lib/agent-client.ts");
  const validate = await jiti.import("../lib/agent/protocol/validate.ts");
  let transportFailure = false;
  const client = createAgentClient({
    basePath: "/v1",
    async fetch() {
      if (transportFailure) throw new TypeError("Connection lost");
      return Response.json({ success: false, error: { code: "command_failed", message: "Prompt rejected" } }, { status: 409 });
    },
  });
  t.mock.method(console, "error", () => {});
  const { render, streams } = await mountExistingSession(t, {
    runEffects: false,
    sendAgentCommand: client.sendCommand,
    virtualModules: { "@/lib/agent/protocol/validate": validate },
  });
  assert.equal(await render().handleSend("rejected input"), false);
  assert.equal(streams[0].readyState, 1);
  let hook = render();
  assert.deepEqual(hook.messages, []);
  assert.equal(hook.agentRunning, false);
  assert.deepEqual(hook.notices.map(({ type, message }) => ({ type, message })), [{ type: "error", message: "Prompt rejected" }]);

  transportFailure = true;
  assert.equal(await hook.handleSend("possibly accepted input"), false);
  hook = render();
  assert.deepEqual(hook.messages.map(({ content }) => content), ["possibly accepted input"]);
  assert.equal(hook.notices.length, 1);
});

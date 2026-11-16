import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { createJiti } from "jiti";

// 保留 React 的稳定 setter、ref 与依赖比较，直接检查真实组件的回调和 effect。
function createHooks() {
  const cells = [];
  let cursor = 0;
  let pendingEffects = [];
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const useState = (initial) => {
    const index = cursor++;
    if (!cells[index]) {
      const cell = { value: typeof initial === "function" ? initial() : initial };
      cell.set = (value) => { cell.value = typeof value === "function" ? value(cell.value) : value; };
      cells[index] = cell;
    }
    return [cells[index].value, cells[index].set];
  };
  const memoize = (fn, deps) => {
    const index = cursor++;
    if (!cells[index] || !sameDeps(cells[index].deps, deps)) cells[index] = { value: fn(), deps };
    return cells[index].value;
  };
  return {
    render(fn) { cursor = 0; return fn(); },
    flushEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) effect();
    },
    cleanup() { for (const cell of cells) cell.cleanup?.(); },
    react: {
      ...React,
      useState,
      useRef(initial) { return useState(() => ({ current: initial }))[0]; },
      useMemo: memoize,
      useCallback(fn, deps) { return memoize(() => fn, deps); },
      useReducer(reducer, initial) {
        const [state, setState] = useState(initial);
        return [state, memoize(() => (action) => setState((value) => reducer(value, action)), [setState, reducer])];
      },
      useEffect(fn, deps) {
        const index = cursor++;
        const previous = cells[index];
        if (!previous || !sameDeps(previous.deps, deps)) {
          const cell = { deps, cleanup: previous?.cleanup };
          cells[index] = cell;
          pendingEffects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
        }
      },
      useImperativeHandle(ref, fn) { if (ref) ref.current = fn(); },
    },
  };
}

function loader(hooks, virtualModules = {}) {
  return createJiti(import.meta.url, {
    moduleCache: false,
    jsx: { runtime: "automatic" },
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: { react: hooks.react, ...virtualModules },
  });
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

const noop = () => {};

function stubGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test("slash completion keeps callbacks stable but refreshes for caret, command and streaming changes", async (t) => {
  const hooks = createHooks();
  t.after(() => hooks.cleanup());
  const translate = (key) => key;
  const { ChatInput } = await loader(hooks, {
    "@/hooks/useI18n": { useI18n: () => ({ t: translate }) },
  }).import("./ChatInput.tsx");
  stubGlobal(t, "document", { addEventListener: noop, removeEventListener: noop });
  const props = {
    onSend: noop, onAbort: noop, isStreaming: false, inputHistory: [],
    slashCommands: [{ name: "demo", source: "extension", description: "Demo" }],
  };
  const replacements = [];
  const render = () => hooks.render(() => ChatInput.render(props, null));
  const editor = (tree) => elements(tree, (node) => typeof node.props?.onSelectionChange === "function")[0];
  const options = (tree) => elements(tree, (node) => node.props?.role === "option");
  const key = (editorNode, value) => editorNode.props.onKeyDown({ key: value, nativeEvent: {}, preventDefault: noop });

  let tree = render();
  hooks.flushEffects();
  editor(tree).props.ref.current = { replace: (...args) => replacements.push(args) };
  editor(tree).props.onChange([{ type: "text", text: "/de" }]);
  editor(tree).props.onSelectionChange("/de", 3);
  tree = render();
  hooks.flushEffects();
  tree = render();
  assert.equal(options(tree).length, 1);
  const stableKeyDown = editor(tree).props.onKeyDown;
  const stablePaste = editor(tree).props.onPaste;
  const stableSelection = editor(tree).props.onSelectionChange;
  props.contextUsage = { percent: 25, contextWindow: 1000, tokens: 250 };
  tree = render();
  assert.equal(editor(tree).props.onKeyDown, stableKeyDown);
  assert.equal(editor(tree).props.onPaste, stablePaste);
  assert.equal(editor(tree).props.onSelectionChange, stableSelection);

  // 同一查询移动到后面的 token：替换范围不能沿用旧的 memo。
  editor(tree).props.onChange([{ type: "text", text: "text /de" }]);
  editor(tree).props.onSelectionChange("text /de", 8);
  tree = render();
  key(editor(tree), "Tab");
  assert.deepEqual(replacements.pop(), [5, 8, [{ type: "text", text: "/demo " }]]);

  props.slashCommands = [{ name: "different", source: "extension", description: "Different" }];
  editor(tree).props.onSelectionChange("/", 1);
  editor(tree).props.onChange([{ type: "text", text: "/" }]);
  render();
  hooks.flushEffects();
  tree = render();
  assert.equal(options(tree).length, 3); // reload、name、扩展命令
  props.isStreaming = true;
  tree = render();
  assert.equal(options(tree).length, 1);
  assert.notEqual(editor(tree).props.onKeyDown, stableKeyDown);
});

test("minimap preserves subscriptions and reads replacement ref contents when callbacks run", async (t) => {
  const hooks = createHooks();
  const { ChatMinimap } = await loader(hooks).import("./ChatMinimap.tsx");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observers = [];
  stubGlobal(t, "ResizeObserver", class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  });
  const listeners = new Map();
  let subscriptions = 0;
  const first = {
    scrollHeight: 1000, clientHeight: 200, scrollTop: 100,
    addEventListener(type, callback) { subscriptions++; listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const replacement = {
    scrollHeight: 2000, clientHeight: 500, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
  };
  const props = {
    messages: [{ role: "user", content: "Hello" }], streamingMessage: null,
    scrollContainer: { current: first },
    messageRefs: { current: [{ getBoundingClientRect: () => ({ top: 100 }) }] },
  };
  const render = () => hooks.render(() => ChatMinimap(props));
  t.after(() => hooks.cleanup());
  render();
  hooks.flushEffects();
  const onScroll = listeners.get("scroll");
  props.scrollContainer.current = replacement;
  props.messageRefs.current = [{ getBoundingClientRect: () => ({ top: 800 }) }];
  onScroll();
  t.mock.timers.tick(150);
  let tree = render();
  tree.props.onMouseEnter();
  tree = render();
  hooks.flushEffects();
  assert.equal(listeners.get("scroll"), onScroll);
  assert.equal(subscriptions, 1);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].disconnected, undefined);
  elements(tree, (node) => node.type === "button")[0].props.onClick();
  assert.equal(replacement.scrollTop, 550);
  assert.equal(first.scrollTop, 100);
});

test("agent extension and queue callbacks use the latest editor handle without recreating callbacks", async (t) => {
  const hooks = createHooks();
  let resolveQueue;
  const { useAgentSession } = await loader(hooks, {
    "@/lib/event-stream": {
      // 事件流改成 fetch 实现后，用替身把连接交回测试里的 EventSource。
      EVENT_STREAM_CONNECTING: 0,
      EVENT_STREAM_OPEN: 1,
      EVENT_STREAM_CLOSED: 2,
      createEventStream: (url) => new globalThis.EventSource(url),
    },
    "@/lib/agent-client": {
      getDefaultAgentClient: () => ({ routes: { events: (id) => "/api/agent/" + id + "/events", runningEvents: () => "/api/agent/running/events", commands: (id) => "/api/agent/" + id, state: (id) => "/api/sessions/" + id + "/state" } }),
      sendAgentCommand(_sid, command) {
        if (command.type === "clear_queue") return new Promise((resolve) => { resolveQueue = resolve; });
        return Promise.resolve(null);
      },
    },
  }).import("../hooks/useAgentSession.ts");
  const streams = [];
  stubGlobal(t, "EventSource", class {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      streams.push(this);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "connected" }) }));
    }
    close() {}
  });
  const received = [];
  const props = {
    session: { id: "refs-session" }, newSessionCwd: null, resolveNewSessionCwd: noop,
    chatInputRef: { current: null },
  };
  const render = () => hooks.render(() => useAgentSession(props));
  let hook = render();
  const recall = hook.handleRecallQueue;
  assert.equal(await hook.handleSend("Hello"), true);
  const pending = recall();
  // 请求发出后编辑器挂载/更换，异步恢复和 SSE 都必须读取新的 handle。
  props.chatInputRef.current = {
    prependText: (text) => received.push(["queue", text]),
    insertText: (text) => received.push(["extension", text]),
  };
  resolveQueue({ steering: ["one"], followUp: ["two"] });
  await pending;
  streams[0].onmessage({ data: JSON.stringify({ type: "extension_ui_request", method: "set_editor_text", text: "latest" }) });
  hook = render();
  assert.equal(hook.handleRecallQueue, recall);
  assert.deepEqual(received, [["queue", "one\n\ntwo"], ["extension", "latest"]]);
});

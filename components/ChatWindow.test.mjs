import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import * as lazyLoad from "../lib/chat-lazy-load.ts";
import * as messageDisplay from "../lib/message-display.ts";

test("turn changes feed the workspace without appending summary cards to the timeline", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /TurnChangesChip|pushTurnChanges|changesByGroup|lastGroupByTurn/);
  assert.match(source, /onTurnChangesChange\?\.\(turnChanges\)/);
  assert.match(source, /<MessageView[\s\S]*?onOpenChanges=\{onOpenChanges\}[\s\S]*?changeToolCallIds=\{changeToolCallIds\}/);
});

// 首条消息会改变空态布局；编辑器不能因此卸载，否则异步提交无法恢复输入。
test("empty and active conversations share one unconditional composer mount", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mounts = [];
  const visit = (node) => {
    if (ts.isJsxExpression(node) && node.expression?.getText(ast) === "chatInputElement") mounts.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(mounts.length, 1);
  for (let parent = mounts[0].parent; parent; parent = parent.parent) {
    assert.ok(!ts.isConditionalExpression(parent), "composer must not live in a layout ternary");
    assert.ok(!(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken),
      "composer must not be conditionally mounted");
  }
});

test("creates history elements only for the current page and reveals older rows on scroll", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const messages = Array.from({ length: 30 }, (_, i) => [
    { role: "user", content: `question ${i}`, timestamp: i * 2 },
    { role: "assistant", content: [
      { type: "toolCall", id: `call-${i}`, name: "read", arguments: {} },
      { type: "text", text: `answer ${i}` },
    ], timestamp: i * 2 + 1 },
  ]).flat();
  const scroll = { scrollHeight: 2000, scrollTop: 500, clientHeight: 800 };
  const sessionState = {
    messages, entryIds: messages.map((_, i) => `entry-${i}`), streamState: {},
    notices: [], extensionWidgets: [], modelThinkingLevels: {}, scrollContainerRef: { current: scroll },
    sessionIdRef: { current: "history" }, lastUserMsgRef: {}, handleFork() {},
  };
  const messageElements = [];
  const effects = [];
  const refs = [];
  let refCursor = 0;
  let stateCursor = 0;
  const states = [];
  let observerCallback;
  let observed;
  const MessageView = () => null;
  const trackElements = (factory) => (type, props, key) => {
    const element = factory(type, props, key);
    if (type === MessageView) messageElements.push(element);
    return element;
  };
  const modules = {
    react: {
      Fragment: jsxRuntime.Fragment,
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useState(initial) {
        const index = stateCursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (update) => { states[index] = update(states[index]); }];
      },
      useRef: (initial) => refs[refCursor++] ??= { current: initial },
      useEffect: (effect) => effects.push(effect),
    },
    "react/jsx-runtime": { ...jsxRuntime, jsx: trackElements(jsxRuntime.jsx), jsxs: trackElements(jsxRuntime.jsxs) },
    "@/hooks/useKeyboardShortcuts": { registerAbortHandler() {} },
    "@/hooks/useAgentSession": { useAgentSession: () => sessionState },
    "@/hooks/useI18n": { useI18n: () => ({ t: (key, params) => key === "chat.loadEarlier" ? `${key}:${params.count}` : key }) },
    "@/hooks/useDragDrop": { useDragDrop: () => ({}) },
    "@/hooks/useIsMobile": { useIsMobile: () => true },
    "@/lib/turn-changes": { deriveTurnChanges: () => [] },
    "@/lib/message-display": messageDisplay,
    "@/lib/chat-lazy-load": lazyLoad,
    "./ChatMinimap": { useMessageRefs: () => ({ current: [] }) },
    "./ChatInput": { ChatInput: () => null },
    "./ExtensionStatusBar": { ExtensionStatusBar: () => null },
    "./MessageView": { MessageView },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, require: (id) => modules[id] ?? {},
    IntersectionObserver: class {
      constructor(callback, options) {
        observerCallback = callback;
        assert.equal(options.root, scroll);
      }
      observe(target) { observed = target; }
      disconnect() {}
    },
  });
  const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes)
    : tree?.props ? [tree, ...nodes(tree.props.children)] : [];
  const sentinel = {};
  let sentinelRef;
  function render() {
    refCursor = 0;
    stateCursor = 0;
    messageElements.length = 0;
    const tree = nodes(exports.ChatWindow({ session: { id: "history", cwd: "/project" } }));
    const loadEarlier = tree.find(({ props }) => typeof props.children === "string" && props.children.startsWith("chat.loadEarlier:"));
    sentinelRef = loadEarlier?.props.ref ?? sentinelRef;
    if (sentinelRef) sentinelRef.current = loadEarlier ? sentinel : null;
    for (const effect of effects.splice(0)) effect();
    return { tree, loadEarlier };
  }
  const initial = render();
  assert.equal(initial.loadEarlier.props.children, "chat.loadEarlier:40", "each grouped turn contributes three rows");
  assert.equal(observed, sentinel);
  assert.equal(initial.tree.find(({ props }) => props.message?.content === "question 0"), undefined);
  assert.equal(messageElements.some(({ props }) => props.entryId === "entry-0"), false, "offscreen user element must not be created");
  assert.equal(messageElements.some(({ props }) => props.entryId === "entry-1"), false, "offscreen process and answer elements must not be created");
  assert.equal(messageElements.some(({ props }) => props.entryId === "entry-26"), false, "the user row just before the window must not be created");
  const latestAnswer = messageElements.find(({ props }) => props.message.content[0]?.text === "answer 29");
  assert.equal(latestAnswer.props.onFork, sessionState.handleFork);
  assert.notEqual(latestAnswer.props.showActions, false);

  observerCallback([{ isIntersecting: true }]);
  scroll.scrollHeight = 2700;
  const revealed = render();
  assert.equal(revealed.loadEarlier, undefined);
  assert.equal(scroll.scrollTop, 1200);
  assert.ok(revealed.tree.some(({ props }) => props.message?.content === "question 0"));
  assert.ok(revealed.tree.some(({ props }) => props.message?.content[0]?.text === "answer 0"));

  const isOlderTool = ({ props }) => props.message?.content[0]?.id === "call-0";
  const olderGroup = revealed.tree.find(({ type, props }) => typeof type === "function" && props.toolCallCount === 1
    && nodes(props.children).some(isOlderTool));
  const groupStateCursor = stateCursor;
  const renderGroup = () => {
    stateCursor = groupStateCursor;
    return nodes(olderGroup.type(olderGroup.props));
  };
  const collapsed = renderGroup();
  assert.ok(!collapsed.some(isOlderTool));
  collapsed.find(({ type }) => type === "button").props.onClick();
  const olderTool = renderGroup().find(isOlderTool);
  assert.equal(olderTool.props.showActions, false);

  sessionState.streamState = {
    isStreaming: true,
    streamingMessage: { role: "assistant", content: [{ type: "text", text: "live reply" }] },
  };
  const streaming = render();
  const persistedTail = streaming.tree.find(({ props }) => props.entryId === "entry-59");
  assert.equal(persistedTail.props.message, messages.at(-1), "live tail stays ungrouped");
  assert.equal(persistedTail.props.showActions, false);
  assert.equal(streaming.tree.find(({ props }) => props.isStreaming)?.props.message, sessionState.streamState.streamingMessage);
});

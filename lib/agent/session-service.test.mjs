import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 真实会话读写与 SDK 树投影；只有置顶文件被指向临时目录，避免触碰真实用户数据。
const root = mkdtempSync(join(tmpdir(), "weclio-session-service-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const cwd = join(root, "workspace");
mkdirSync(cwd, { recursive: true });
const sidebarPath = join(root, "sidebar.json");

const bareJiti = createJiti(import.meta.url);
const pins = await bareJiti.import("../sidebar-pins.ts");
const { AgentProtocolError } = await bareJiti.import("./protocol/validate.ts");
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "../sidebar-pins": {
      setSidebarPin: (pin, pinned) => pins.setSidebarPin(pin, pinned, sidebarPath),
    },
  },
});
const {
  deleteSession,
  listSessionCatalog,
  listSessionTitles,
  readSessionRuntimeState,
  readSessionView,
  renameSession,
} = await jiti.import("./session-service.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { invalidateSessionListCache } = await bareJiti.import("../session-reader.ts");
const { readFileSync: readFile } = await import("node:fs");
const readHeader = (path) => JSON.parse(readFile(path, "utf8").split("\n")[0]);

test.after(() => rmSync(root, { recursive: true, force: true }));

function newSession(parentPath) {
  const manager = SessionManager.create(cwd);
  if (parentPath) manager.newSession({ parentSession: parentPath });
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  const file = manager.getSessionFile();
  assert.ok(file && existsSync(file), "fixture session must be persisted");
  // 生产路径在创建/改名后失效目录缓存；测试直接建会话也要保持同等语义。
  invalidateSessionListCache();
  return { id: manager.getSessionId(), file, manager };
}

function runtimeWith(session) {
  return {
    runningIds: () => (session ? [session.sessionId] : []),
    getSession: () => session,
  };
}

test("catalog merges persisted sessions with runtime ids", async () => {
  const session = newSession();
  const catalog = await listSessionCatalog(runtimeWith({ sessionId: session.id }));
  assert.ok(catalog.sessions.some((entry) => entry.id === session.id));
  assert.deepEqual(catalog.runningSessionIds, [session.id]);
});

test("title batch rejects oversized or non-string ids", async () => {
  for (const ids of [Array(101).fill("id"), [42]]) {
    await assert.rejects(listSessionTitles(ids), (error) => {
      assert.ok(error instanceof AgentProtocolError);
      assert.equal(error.code, "invalid_argument");
      return true;
    });
  }
});

test("read-only view returns info, tree and context without starting a runtime", async () => {
  const session = newSession();
  session.manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "m",
    content: [{ type: "text", text: "hi" }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const view = await readSessionView(session.id, { deferThinking: true });
  assert.equal(view.sessionId, session.id);
  assert.equal(view.info?.id, session.id);
  assert.equal(view.info?.firstMessage, "hello");
  assert.equal(view.info?.messageCount, 2);
  assert.ok(view.tree.length >= 1);
  assert.deepEqual(view.context.messages.map((message) => message.role), ["user", "assistant"]);
});

test("navigation tree keeps branch IDs and labels without carrying transcript payloads", async () => {
  const session = newSession();
  const { manager } = session;
  const rootId = manager.getLeafId();
  const compressedId = manager.appendLabelChange(rootId, "Pinned root");
  const image = Buffer.from("large image fixture ".repeat(4096)).toString("base64");
  const thinking = "thinking fixture ".repeat(4096);
  const extensionData = "extension data fixture ".repeat(4096);
  const branchId = manager.appendMessage({
    role: "toolResult", toolName: "fixture", toolCallId: "call", isError: false, timestamp: Date.now(),
    content: [{ type: "text", text: "output" }, { type: "image", data: image, mimeType: "image/png" }],
  });
  const alternateId = manager.appendCustomEntry("alternate", { data: extensionData });
  manager.branch(branchId);
  const prefix = "a".repeat(37);
  const leafId = manager.appendMessage({
    role: "assistant", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    content: [{ type: "thinking", thinking }, { type: "text", text: prefix }, { type: "text", text: "second block" }],
  });

  const view = await readSessionView(session.id, { tree: "preview", deferThinking: true, deferToolResultImages: true });
  const serialized = JSON.stringify(view);
  for (const payload of [image, thinking, extensionData]) assert.ok(!serialized.includes(payload));
  const [root] = view.tree;
  assert.equal(view.tree.length, 1);
  assert.equal(root.entry.id, rootId);
  assert.equal(root.label, "Pinned root");
  assert.equal(root.labelTimestamp, manager.getEntry(compressedId).timestamp);
  assert.equal(root.children.length, 1);
  const [branch] = root.children;
  assert.deepEqual(branch.compressedEntryIds, [compressedId]);
  assert.deepEqual(branch.entry, { id: branchId, type: "message", message: { role: "toolResult", content: "output" } });
  assert.deepEqual(branch.children.map(({ entry }) => entry), [
    { id: alternateId, type: "custom" },
    { id: leafId, type: "message", message: { role: "assistant", content: `${prefix} se…` } },
  ]);
  assert.equal(view.leafId, leafId);
  assert.equal(view.context.messages.at(-1).content[2].text, "second block");

  const full = await readSessionView(session.id, { tree: "preview" });
  assert.deepEqual(full.tree, view.tree);
  const legacy = await readSessionView(session.id, { deferThinking: true, deferToolResultImages: true });
  const legacyBranch = legacy.tree[0].children[0];
  assert.deepEqual(legacyBranch.entry, manager.getEntry(branchId));
  assert.deepEqual(legacyBranch.children.map(({ entry }) => entry), [manager.getEntry(alternateId), manager.getEntry(leafId)]);
  assert.deepEqual(legacyBranch.compressedEntryIds, [compressedId]);
  assert.deepEqual(legacy.context, view.context);
  const fullContext = JSON.stringify(full.context);
  assert.ok(fullContext.includes(image));
  assert.ok(fullContext.includes(thinking));
});

test("view reports a typed not-found error", async () => {
  await assert.rejects(readSessionView("missing-session"), (error) => {
    assert.ok(error instanceof AgentProtocolError);
    assert.equal(error.code, "session_not_found");
    return true;
  });
});

test("rename goes through the live manager so pending auto-naming observes it", async () => {
  const session = newSession();
  const commands = [];
  const live = { isAlive: () => true, send: async (command) => { commands.push(command); } };
  const runtime = { getSession: () => live, runningIds: () => [] };
  await renameSession(session.id, "  Manual  ", runtime);
  assert.deepEqual(commands, [{ type: "set_session_name", name: "Manual" }]);
  assert.equal(session.manager.getSessionName(), undefined);
});

test("offline rename appends metadata to the persisted session", async () => {
  const session = newSession();
  await renameSession(session.id, "Offline", runtimeWith(undefined));
  assert.equal(SessionManager.open(session.file).getSessionName(), "Offline");
});

test("delete re-parents direct children without reading unrelated transcript bodies", async (t) => {
  const parent = newSession();
  const target = newSession(parent.file);
  const child = newSession(target.file);
  const grandchild = newSession(child.file);
  newSession();
  const body = readFile(child.file, "utf8").split("\n").slice(1).join("\r\n");
  writeFileSync(child.file, `${JSON.stringify(readHeader(child.file))}\r\n${body}`);
  pins.setSidebarPin({ type: "session", id: target.id }, true, sidebarPath);
  let shutdowns = 0;
  const runtime = {
    getSession: () => ({ shutdown: async () => { shutdowns += 1; } }),
    runningIds: () => [],
  };

  const read = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  try {
    await deleteSession(target.id, runtime);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }

  const transcriptReads = read.mock.calls.map(({ arguments: [path] }) => path)
    .filter((path) => typeof path === "string" && path.endsWith(".jsonl")).map(normalize);
  assert.deepEqual(transcriptReads, [normalize(child.file)]);
  assert.equal(existsSync(target.file), false);
  assert.equal(shutdowns, 1);
  assert.equal(readHeader(child.file).parentSession, parent.file);
  assert.equal(readHeader(grandchild.file).parentSession, child.file);
  assert.equal(readFile(child.file, "utf8").split("\r\n").slice(1).join("\r\n"), body);
  assert.deepEqual(pins.readSidebarPins(sidebarPath), []);
});

test("a failing pin write preserves the session, child linkage and runtime", async () => {
  const parent = newSession();
  const target = newSession(parent.file);
  const child = newSession(target.file);
  writeFileSync(sidebarPath, "broken json");
  let shutdowns = 0;
  const runtime = {
    getSession: () => ({ shutdown: async () => { shutdowns += 1; } }),
    runningIds: () => [],
  };

  try {
    await deleteSession(target.id, runtime);
    assert.fail("delete must fail when the pin cannot be cleared");
  } catch {
    assert.equal(existsSync(target.file), true);
    assert.equal(shutdowns, 0);
    const childHeader = readHeader(child.file);
    assert.equal(childHeader.parentSession, target.file);
  } finally {
    rmSync(sidebarPath, { force: true });
  }
});

test("runtime state reports running sessions without creating one", async () => {
  const session = newSession();
  assert.deepEqual(await readSessionRuntimeState(session.id, runtimeWith(undefined)), { running: false });
  const state = await readSessionRuntimeState(session.id, runtimeWith({
    sessionId: session.id,
    isAlive: () => true,
    send: async () => ({ sessionId: session.id }),
  }));
  assert.equal(state.running, true);
  assert.deepEqual(state.state, { sessionId: session.id });
});

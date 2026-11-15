import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentProtocolError } from "./protocol/validate";
import type { AgentRuntime } from "../rpc-manager";
import {
  buildSessionContext,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  loadSessionTitles,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
} from "../session-reader";
import { sessionPathKey } from "../session-path";
import { setSidebarPin } from "../sidebar-pins";

// BranchNavigator 仍递归遍历；响应层保持浅树。
const MAX_PROJECTED_TREE_DEPTH = 200;

interface NavNode {
  entry: { id: string };
  children: NavNode[];
  compressedEntryIds?: string[];
}

/**
 * 把会话树投影成客户端导航用的浅树：保留根、分支点与叶子，
 * 单子节点链被压缩，链上的 entry ID 附到下一个可见节点。
 */
function projectTreeForResponse(nodes: NavNode[]): NavNode[] {
  const keep = new Set<NavNode>();
  const roots = new Set(nodes);
  const seen = new Set<NavNode>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (roots.has(node) || node.children.length !== 1) keep.add(node);
    for (const child of node.children) stack.push(child);
  }

  const cloneNode = (node: NavNode, compressedEntryIds?: string[]): NavNode => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({ source, projected: projectedRoots[index], depth: 1 }));

  const appendFlattenedKeptDescendants = (source: NavNode, projectedParent: NavNode) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[] }];
    const flattenedSeen = new Set<NavNode>();
    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);
      if (keep.has(node)) projectedParent.children.push(cloneNode(node, compressedEntryIds));
      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node) ? [] : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;
    for (const sourceChild of source.children) {
      let child = sourceChild;
      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }
      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }
      if (!keep.has(child)) continue;
      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

function requireSessionPath(id: string): Promise<string> {
  return resolveSessionPath(id).then((path) => {
    if (!path) throw new AgentProtocolError("session_not_found", `Session not found: ${id}`);
    return path;
  });
}

export interface SessionCatalog {
  sessions: Awaited<ReturnType<typeof listAllSessions>>;
  runningSessionIds: string[];
}

export async function listSessionCatalog(runtime: AgentRuntime): Promise<SessionCatalog> {
  return { sessions: await listAllSessions(), runningSessionIds: runtime.runningIds() };
}

export async function listSessionTitles(ids: string[]): Promise<Awaited<ReturnType<typeof loadSessionTitles>>> {
  if (ids.length > 100 || !ids.every((id) => typeof id === "string")) {
    throw new AgentProtocolError("invalid_argument", "ids must contain at most 100 session IDs");
  }
  return loadSessionTitles(ids);
}

export interface SessionViewOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
}

/** 只读历史视图：不创建运行实例，避免与活跃 writer 竞争同一 JSONL。 */
export async function readSessionView(id: string, options: SessionViewOptions = {}) {
  const filePath = await requireSessionPath(id);
  const manager = SessionManager.open(filePath);
  const entries = manager.getEntries() as never;
  const leafId = manager.getLeafId();
  const tree = projectTreeForResponse(manager.getTree() as unknown as NavNode[]);
  const context = buildSessionContext(entries, leafId, {
    deferThinking: Boolean(options.deferThinking),
    deferToolResultImages: Boolean(options.deferToolResultImages),
  });

  const header = manager.getHeader();
  let modified = header?.timestamp ?? new Date().toISOString();
  try { modified = statSync(filePath).mtime.toISOString(); } catch { /* 保留 header 时间戳 */ }
  const parentSessionId = header?.parentSession ? await resolveSessionIdByPath(header.parentSession) : undefined;
  const firstUser = context.messages.find((message) => message.role === "user");
  const firstContent = (firstUser as { content?: unknown } | undefined)?.content;
  const firstMessage = typeof firstContent === "string"
    ? firstContent
    : (Array.isArray(firstContent)
      ? (firstContent.find((block: { type: string }) => block.type === "text") as { text: string } | undefined)?.text ?? ""
      : "") || "(no messages)";

  const info = header ? {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    name: manager.getSessionName(),
    created: header.timestamp,
    modified,
    messageCount: context.messages.length,
    firstMessage,
    parentSessionId,
  } : null;

  return { sessionId: id, filePath, info, leafId, tree, context };
}

/** 活跃会话与历史文件共用同一份元数据；离线时只追加会话信息条目。 */
export async function renameSession(
  id: string,
  name: string,
  runtime: AgentRuntime,
): Promise<void> {
  if (typeof name !== "string") throw new AgentProtocolError("invalid_argument", "name is required");
  const filePath = await requireSessionPath(id);
  const live = runtime.getSession(id);
  if (live?.isAlive()) {
    await live.send({ type: "set_session_name", name: name.trim() });
    return;
  }
  SessionManager.open(filePath).appendSessionInfo(name.trim());
  invalidateSessionListCache();
}

/** 删除前先释放运行实例；子会话重新挂到被删会话的父级。 */
export async function deleteSession(id: string, runtime: AgentRuntime): Promise<void> {
  const filePath = await requireSessionPath(id);

  // 置顶清理失败时保留会话文件与运行实例，避免半删状态。
  setSidebarPin({ type: "session", id }, false);

  const parentSessionPath = readSessionHeader(filePath)?.parentSession;
  const targetPathKey = sessionPathKey(filePath);
  const directory = dirname(filePath);
  try {
    const files = readdirSync(directory).filter(
      (file) => file.endsWith(".jsonl") && sessionPathKey(join(directory, file)) !== targetPathKey,
    );
    for (const file of files) {
      const childPath = join(directory, file);
      try {
        const lines = readFileSync(childPath, "utf8").split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (header.type === "session" && header.parentSession && sessionPathKey(header.parentSession) === targetPathKey) {
          header.parentSession = parentSessionPath;
          lines[0] = JSON.stringify(header);
          writeFileSync(childPath, lines.join("\n"));
        }
      } catch { /* 跳过损坏的子会话 */ }
    }
  } catch { /* 目录不可读时仅删除本文件 */ }

  await runtime.getSession(id)?.shutdown();
  unlinkSync(filePath);
  invalidateSessionPathCache(id);
  invalidateSessionListCache();
}

export interface SessionRuntimeState {
  running: boolean;
  state?: unknown;
}

export async function readSessionRuntimeState(
  id: string,
  runtime: AgentRuntime,
): Promise<SessionRuntimeState> {
  await requireSessionPath(id);
  const session = runtime.getSession(id);
  if (!session?.isAlive()) return { running: false };
  return { running: true, state: await session.send({ type: "get_state" }) };
}

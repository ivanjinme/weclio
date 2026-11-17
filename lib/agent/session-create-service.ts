import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "../file-access";
import type { AgentRuntime } from "../rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "../session-reader";
import { AgentProtocolError, parseAgentCommand } from "./protocol/validate";

/** 创建入口只负责会话语义；HTTP 与 runtime 所有权由宿主提供。 */
export async function createSession(input: unknown, runtime: AgentRuntime) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentProtocolError("invalid_argument", "Request must be a JSON object");
  }
  const { cwd, provider, modelId, toolNames, toolPreset, thinkingLevel, ...command } = input as Record<string, unknown>;
  if (typeof cwd !== "string" || !cwd) throw new AgentProtocolError("invalid_argument", "cwd is required");
  let directory = false;
  try { directory = statSync(cwd).isDirectory(); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  if (!directory) throw new AgentProtocolError("invalid_argument", `Directory does not exist: ${cwd}`);

  // 在分配 runtime 前使用已有协议校验，避免无效请求遗留会话。
  const promptCommand = command.type === "ensure_session" ? null : parseAgentCommand(command);
  const tools = toolNames !== undefined || toolPreset !== undefined
    ? parseAgentCommand({ type: "set_tools", toolNames, preset: toolPreset }) : undefined;
  const model = provider !== undefined || modelId !== undefined
    ? parseAgentCommand({ type: "set_model", provider, modelId }) : undefined;
  const thinking = thinkingLevel !== undefined
    ? parseAgentCommand({ type: "set_thinking_level", level: thinkingLevel }) : undefined;
  const { session, realSessionId } = await runtime.startSession(
    `__new__${randomUUID()}`, "", cwd,
    tools?.type === "set_tools" ? tools.toolNames : undefined,
    tools?.type === "set_tools" ? tools.preset : undefined,
  );
  allowFileRoot(cwd);
  invalidateSessionListCache();
  if (model) await session.send(model);
  if (thinking) await session.send(thinking);
  const data = promptCommand ? await session.send(promptCommand) : null;
  return { success: true, sessionId: realSessionId, data };
}

/** 冷启动必须恢复原文件及其 cwd，不得以旧 ID 创建一个空白会话。 */
export async function resumeSession(id: string, runtime: AgentRuntime) {
  const existing = runtime.getSession(id);
  if (existing?.isAlive()) return existing;
  const filePath = await resolveSessionPath(id);
  if (!filePath) throw new AgentProtocolError("session_not_found", "Session not found");
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  return (await runtime.startSession(id, filePath, cwd)).session;
}

// Agent Client：唯一客户端接缝。
// 当前 transport 直连 Next 路由；接入独立 Service 时只改 endpoint/basePath，不改调用点。

import type { AgentCommand, AgentCommandResult } from "./agent/protocol/commands";
import { getApiBase } from "./api-base";
import { routesForBase, type HostRoutes } from "./agent/routes";
import { AgentProtocolError, isAgentProtocolErrorCode } from "./agent/protocol/validate";

export interface AgentClientOptions {
  /** 覆盖宿主路由表；默认按 basePath 推断。 */
  routes?: HostRoutes;
  /** Service 源，例如 https://vm:8443；留空表示同源。 */
  baseUrl?: string;
  /** 路由前缀：当前是 /api，独立 Service 使用 /v1。 */
  basePath?: string;
  /** 每次请求前解析认证头，避免长期凭据进入 URL 或日志。 */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface AgentCommandOptions {
  signal?: AbortSignal;
}

export interface AgentClient {
  /** 当前生效的宿主路由（事件流等直接取 URL 的调用点使用）。 */
  readonly routes: HostRoutes;
  sendCommand<C extends AgentCommand>(
    sessionId: string,
    command: C,
    options?: AgentCommandOptions,
  ): Promise<AgentCommandResult<C>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessEnvelope(value: unknown): value is { success: true; data: unknown } {
  return isRecord(value) && value.success === true;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function readRequestId(response: Response, envelope: unknown): string | undefined {
  const header = response.headers.get("x-request-id");
  if (header) return header;
  if (!isRecord(envelope)) return undefined;
  if (typeof envelope.requestId === "string") return envelope.requestId;
  const error = envelope.error;
  return isRecord(error) && typeof error.requestId === "string" ? error.requestId : undefined;
}

function readErrorPayload(envelope: unknown): { code?: unknown; message: string } | undefined {
  if (!isRecord(envelope)) return undefined;
  const error = envelope.error;
  // 旧式 { error: "文本" } 只作为消息来源，不构成需要维护的第二套协议。
  if (typeof error === "string") return { message: error };
  if (isRecord(error) && typeof error.message === "string") {
    return { code: error.code, message: error.message };
  }
  return undefined;
}

function toProtocolError(response: Response, envelope: unknown): AgentProtocolError {
  const requestId = readRequestId(response, envelope);
  const payload = readErrorPayload(envelope);
  if (!payload) {
    return new AgentProtocolError("http_error", `HTTP ${response.status}`, { requestId });
  }
  const code = isAgentProtocolErrorCode(payload.code) ? payload.code : "command_failed";
  return new AgentProtocolError(code, payload.message, { requestId });
}

export function createAgentClient(options: AgentClientOptions = {}): AgentClient {
  // 未显式指定时跟随全局 API 基址（默认同源 /api）。
  const configured = getApiBase();
  const baseUrl = (options.baseUrl ?? configured.baseUrl).replace(/\/+$/, "");
  const basePath = options.basePath ?? configured.basePath;
  // 命令、事件与状态 URL 由宿主决定，调用点不需要知道当前连的是谁。
  const routes: HostRoutes = options.routes ?? routesForBase({ baseUrl, basePath });
  const doFetch = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));

  return {
    routes,
    async sendCommand(sessionId, command, commandOptions) {
      const headers = { ...(await options.headers?.()), "Content-Type": "application/json" };
      let response: Response;
      try {
        response = await doFetch(routes.commands(sessionId), {
          method: "POST",
          headers,
          body: JSON.stringify(command),
          signal: commandOptions?.signal ?? options.signal,
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") throw cause;
        throw new AgentProtocolError("http_error", cause instanceof Error ? cause.message : String(cause), { cause });
      }

      const envelope = await readJson(response);
      if (!response.ok || !isSuccessEnvelope(envelope)) throw toProtocolError(response, envelope);
      if (!("data" in envelope)) {
        throw new AgentProtocolError("invalid_response", "Response is missing data", { requestId: readRequestId(response, envelope) });
      }
      return envelope.data as AgentCommandResult<typeof command>;
    },
  };
}

let defaultClient: { baseUrl: string; basePath: string; client: AgentClient } | undefined;

/** 默认 Client 跟随当前 API 基址；基址变化后自动重建（含宿主路由）。 */
export function getDefaultAgentClient(): AgentClient {
  const base = getApiBase();
  if (!defaultClient || defaultClient.baseUrl !== base.baseUrl || defaultClient.basePath !== base.basePath) {
    defaultClient = { ...base, client: createAgentClient(base) };
  }
  return defaultClient.client;
}

export function sendAgentCommand<C extends AgentCommand>(
  sessionId: string,
  command: C,
  options?: AgentCommandOptions,
): Promise<AgentCommandResult<C>> {
  return getDefaultAgentClient().sendCommand(sessionId, command, options);
}

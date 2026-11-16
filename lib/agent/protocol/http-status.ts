import { AgentProtocolError, type AgentProtocolErrorCode } from "./validate";

// 协议错误码 → HTTP 状态；Next 适配层与独立 Service 共用同一映射。
export function statusForProtocolCode(code: AgentProtocolErrorCode): number {
  switch (code) {
    case "session_not_found":
    case "not_found":
      return 404;
    case "unauthorized":
      return 401;
    case "forbidden":
    case "forbidden_origin":
      return 403;
    case "invalid_command":
    case "invalid_argument":
      return 400;
    case "conflict":
      return 409;
    case "payload_too_large":
      return 413;
    case "bad_gateway":
      return 502;
    default:
      return 500;
  }
}

/** 统一的错误载荷；非协议错误一律视为执行失败。 */
export function errorPayload(error: unknown): { code: AgentProtocolErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: error instanceof AgentProtocolError ? error.code : "command_failed",
    message,
  };
}

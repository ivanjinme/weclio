import { NextResponse } from "next/server";
import { errorPayload, statusForProtocolCode } from "./protocol/http-status";

// 仅 Next 适配层使用：把业务抛出的协议错误映射为统一 HTTP 响应。
export function protocolErrorResponse(error: unknown) {
  const { code, message } = errorPayload(error);
  return NextResponse.json({ error: message, code }, { status: statusForProtocolCode(code) });
}

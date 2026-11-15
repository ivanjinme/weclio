import { NextResponse } from "next/server";
import { AgentProtocolError, isAgentProtocolErrorCode } from "@/lib/agent/protocol/validate";
import { listSessionCatalog, listSessionTitles } from "@/lib/agent/session-service";
import { getDefaultRuntime } from "@/lib/rpc-manager";

// 业务在 lib/agent/session-service；本路由只做 HTTP 适配，独立 Service 复用同一实现。
function errorResponse(error: unknown) {
  const code = error instanceof AgentProtocolError && isAgentProtocolErrorCode(error.code) ? error.code : "command_failed";
  const status = code === "session_not_found" ? 404 : code === "invalid_argument" ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
}

// POST 只接收目录中已有的 ID，不能由客户端指定文件路径。
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_argument" }, { status: 400 });
  }
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids must contain at most 100 session IDs", code: "invalid_argument" }, { status: 400 });
  }
  try {
    return NextResponse.json({ titles: await listSessionTitles(ids as string[]) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  try {
    return NextResponse.json(await listSessionCatalog(getDefaultRuntime()));
  } catch (error) {
    return errorResponse(error);
  }
}

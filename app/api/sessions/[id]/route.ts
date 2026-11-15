import { NextResponse } from "next/server";
import { AgentProtocolError, isAgentProtocolErrorCode } from "@/lib/agent/protocol/validate";
import { deleteSession, readSessionView, renameSession } from "@/lib/agent/session-service";
import { getDefaultRuntime } from "@/lib/rpc-manager";

// 业务在 lib/agent/session-service；本路由只做 HTTP 适配。
function errorResponse(error: unknown) {
  const code = error instanceof AgentProtocolError && isAgentProtocolErrorCode(error.code) ? error.code : "command_failed";
  const status = code === "session_not_found" ? 404 : code === "invalid_argument" ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const query = new URL(req.url).searchParams;
    return NextResponse.json(await readSessionView(id, {
      deferThinking: query.has("deferThinking"),
      deferToolResultImages: query.has("deferMedia"),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required", code: "invalid_argument" }, { status: 400 });
    }
    await renameSession(id, name, getDefaultRuntime());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await deleteSession(id, getDefaultRuntime());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { AgentProtocolError, parseAgentCommand, type AgentProtocolErrorCode } from "@/lib/agent/protocol/validate";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const INVALID_CODES = new Set<AgentProtocolErrorCode>(["invalid_command", "invalid_argument"]);

function errorResponse(status: number, code: AgentProtocolErrorCode, message: string, requestId: string) {
  return NextResponse.json({ success: false, error: { code, message, requestId } }, { status });
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = randomUUID();
  const { id } = await params;

  try {
    // 运行时校验：编译期类型不等于可信输入。
    const command = parseAgentCommand(await req.json());

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(command);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return errorResponse(404, "session_not_found", "Session not found", requestId);
    }

    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

    const { session } = await startRpcSession(id, filePath, cwd);
    const result = await session.send(command);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AgentProtocolError) {
      return errorResponse(INVALID_CODES.has(error.code) ? 400 : 500, error.code, message, error.requestId ?? requestId);
    }
    return errorResponse(500, "command_failed", message, requestId);
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

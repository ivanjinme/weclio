import { NextResponse } from "next/server";
import { AgentProtocolError, isAgentProtocolErrorCode } from "@/lib/agent/protocol/validate";
import { readSessionRuntimeState } from "@/lib/agent/session-service";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await readSessionRuntimeState(id, getDefaultRuntime()));
  } catch (error) {
    const code = error instanceof AgentProtocolError && isAgentProtocolErrorCode(error.code) ? error.code : "command_failed";
    const status = code === "session_not_found" ? 404 : code === "invalid_argument" ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
  }
}

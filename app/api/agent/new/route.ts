import { NextResponse } from "next/server";
import { createSession } from "@/lib/agent/session-create-service";
import { AgentProtocolError } from "@/lib/agent/protocol/validate";
import { statusForProtocolCode } from "@/lib/agent/protocol/http-status";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export async function POST(req: Request) {
  try {
    return NextResponse.json(await createSession(await req.json(), getDefaultRuntime()));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, {
      status: error instanceof AgentProtocolError ? statusForProtocolCode(error.code) : 500,
    });
  }
}

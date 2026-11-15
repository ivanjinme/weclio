import { NextResponse } from "next/server";
import { listPins, setPinned } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export async function GET() {
  try {
    return NextResponse.json({ pins: listPins() });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { type, id, pinned } = await request.json() as { type?: unknown; id?: unknown; pinned?: unknown };
    if (typeof id !== "string" || typeof pinned !== "boolean") {
      return NextResponse.json({ error: "type, id and pinned are required", code: "invalid_argument" }, { status: 400 });
    }
    return NextResponse.json({ pins: setPinned(type as "project" | "session", id, pinned) });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

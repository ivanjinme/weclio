import { NextResponse } from "next/server";
import { validateWorkspace } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const { cwd } = validateWorkspace(body.cwd);
    return NextResponse.json({ success: true, cwd });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

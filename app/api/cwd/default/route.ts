import { NextResponse } from "next/server";
import { getDefaultWorkspacePath } from "@/lib/default-workspace";
import { ensureWorkspace } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export async function GET() {
  return NextResponse.json({ cwd: getDefaultWorkspacePath() });
}

// Creates one deterministic fallback workspace. This intentionally performs no
// home-directory enumeration: output tracing must never discover user files.
export async function POST() {
  try {
    return NextResponse.json({ cwd: ensureWorkspace(getDefaultWorkspacePath()) });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

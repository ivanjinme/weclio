import { NextResponse } from "next/server";
import { browseWorkspace } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("path");
    return NextResponse.json(await browseWorkspace(requested));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

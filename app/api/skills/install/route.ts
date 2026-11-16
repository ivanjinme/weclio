import { NextResponse } from "next/server";
import { installSkill } from "@/lib/agent/skill-actions-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// 安装是外部子进程，占用执行准入以免与更新/关停竞争。
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", code: "forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_argument" }, { status: 415 });
  }
  try {
    const runtime = getDefaultRuntime();
    return NextResponse.json(await installSkill(await req.json(), () => runtime.reserveTask()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

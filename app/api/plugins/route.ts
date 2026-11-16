import { NextResponse } from "next/server";
import { listPlugins, mutatePlugins, type PluginMutationInput } from "@/lib/agent/plugins-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// 业务在 lib/agent/plugins-service；本路由只做 HTTP 适配与请求安全检查。
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return NextResponse.json(await listPlugins({
      cwd: searchParams.get("cwd"),
      globalOnly: searchParams.get("global") === "true",
    }));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

// POST body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", code: "forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_argument" }, { status: 415 });
  }
  try {
    return NextResponse.json(await mutatePlugins(await req.json() as PluginMutationInput));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

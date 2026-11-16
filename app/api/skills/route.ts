import { NextResponse } from "next/server";
import { listSkills, setSkillModelInvocation } from "@/lib/agent/skill-actions-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

// 业务在 lib/agent/skill-actions-service；本路由只做 HTTP 适配。
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return NextResponse.json(await listSkills({
      cwd: searchParams.get("cwd"),
      globalOnly: searchParams.get("global") === "true",
    }));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    await setSkillModelInvocation(await req.json());
    return NextResponse.json({ success: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { setDefaultModel } from "@/lib/agent/settings-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { getDefaultWorkspacePath } from "@/lib/default-workspace";

export const dynamic = "force-dynamic";

// 记住用户最后选择的模型为全局默认，新会话（任何浏览器）从它开始。
export async function PUT(req: Request) {
  try {
    const { provider, modelId } = (await req.json()) as { provider?: unknown; modelId?: unknown };
    await setDefaultModel(provider, modelId, getDefaultWorkspacePath());
    return NextResponse.json({ success: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

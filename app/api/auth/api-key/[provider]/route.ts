import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyStatus, saveApiKey } from "@/lib/agent/provider-auth-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// GET — 只返回状态与来源，永不返回密钥本身。
export async function GET(_req: Request, { params }: Params) {
  try {
    const { provider } = await params;
    return NextResponse.json(await getApiKeyStatus(provider));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

// POST body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  try {
    const { provider } = await params;
    const { apiKey } = await req.json() as { apiKey?: unknown };
    await saveApiKey(provider, apiKey);
    return NextResponse.json({ success: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

// DELETE — 移除已保存的 API key。
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { provider } = await params;
    await deleteApiKey(provider);
    return NextResponse.json({ success: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

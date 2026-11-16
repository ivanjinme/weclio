import { NextResponse } from "next/server";
import { listApiKeyProviders } from "@/lib/agent/provider-auth-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

// 走 OAuth 的 provider 由 /api/auth/providers 单独处理。
export async function GET() {
  try {
    return NextResponse.json(await listApiKeyProviders());
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

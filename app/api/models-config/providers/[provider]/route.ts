import { NextResponse } from "next/server";
import { refreshProviderModels } from "@/lib/agent/provider-auth-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { provider } = await params;
    return NextResponse.json(await refreshProviderModels(provider));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

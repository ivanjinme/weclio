import { NextResponse } from "next/server";
import { logoutProvider } from "@/lib/agent/provider-auth-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await params;
    await logoutProvider(provider);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

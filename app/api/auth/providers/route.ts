import { NextResponse } from "next/server";
import { listOAuthProviders } from "@/lib/agent/provider-auth-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listOAuthProviders());
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

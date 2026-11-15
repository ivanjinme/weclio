import { NextResponse } from "next/server";
import { testModel } from "@/lib/agent/settings-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ ok: false, error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    return NextResponse.json(await testModel(await req.json()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

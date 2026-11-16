import { NextResponse } from "next/server";
import { checkUpdates } from "@/lib/agent/skill-actions-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return NextResponse.json(await checkUpdates(await req.json()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

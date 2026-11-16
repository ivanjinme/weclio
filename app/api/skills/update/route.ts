import { NextResponse } from "next/server";
import { updateSkill } from "@/lib/agent/skill-actions-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const runtime = getDefaultRuntime();
    return NextResponse.json(await updateSkill(await req.json(), () => runtime.reserveTask()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

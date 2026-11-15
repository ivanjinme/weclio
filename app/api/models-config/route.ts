import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/agent/settings-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    writeModelsConfig(await req.json());
    return NextResponse.json({ success: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

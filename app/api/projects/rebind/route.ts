import { NextResponse } from "next/server";
import { rebindProject } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { oldRoot?: unknown; newRoot?: unknown };
    return NextResponse.json(await rebindProject(body, getDefaultRuntime()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

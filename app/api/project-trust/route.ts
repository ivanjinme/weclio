import { NextResponse } from "next/server";
import { grantProjectTrust, readProjectTrust } from "@/lib/agent/workspace-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { getDefaultRuntime } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return NextResponse.json(await readProjectTrust(new URL(req.url).searchParams.get("cwd")));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    return NextResponse.json(await grantProjectTrust(body.cwd, getDefaultRuntime()));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

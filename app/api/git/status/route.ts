import { NextResponse } from "next/server";
import { gitStatus } from "@/lib/agent/git-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd");
    return NextResponse.json(await gitStatus(cwd));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

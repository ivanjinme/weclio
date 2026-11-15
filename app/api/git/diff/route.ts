import { NextResponse } from "next/server";
import { gitDiff } from "@/lib/agent/git-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return NextResponse.json(await gitDiff(query.get("cwd"), query.get("path")));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

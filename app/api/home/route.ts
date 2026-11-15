import { NextResponse } from "next/server";
import { getHomeDirectory } from "@/lib/agent/workspace-service";

export async function GET() {
  return NextResponse.json({ home: getHomeDirectory() });
}

import { NextResponse } from "next/server";
import { listModels } from "@/lib/agent/settings-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";
import { getDefaultWorkspacePath } from "@/lib/default-workspace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    return NextResponse.json(await listModels({ cwd, defaultWorkspace: getDefaultWorkspacePath() }));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelsJsonFile, writeModelsJsonFile } from "@/lib/models-config-file";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export async function GET() {
  try {
    return NextResponse.json(readModelsJsonFile(getModelsPath()));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body: unknown = await req.json();
    writeModelsJsonFile(getModelsPath(), body);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

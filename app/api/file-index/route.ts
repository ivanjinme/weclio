import { NextResponse } from "next/server";
import { fileIndex } from "@/lib/agent/file-index-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

// GET /api/file-index?cwd=/abs/path[&q=query]
// 无 q：客户端索引（截断到 5000）；有 q：在完整列表上排序匹配。
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return NextResponse.json(await fileIndex(query.get("cwd"), query.get("q")));
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

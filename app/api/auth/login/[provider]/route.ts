import { NextResponse } from "next/server";
import { getDefaultOAuthLoginManager, type OAuthClientEvent } from "@/lib/agent/oauth-login-service";
import { protocolErrorResponse } from "@/lib/agent/next-error-response";

export const dynamic = "force-dynamic";

// POST — 浏览器回填跳转 URL 或授权码；登录编排在 lib/agent/oauth-login-service。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    // provider 只用于校验路径本身合法；token 决定实际挂起的登录。
    await params;
    const { token, code } = (await req.json()) as { token?: unknown; code?: unknown };
    if (typeof token !== "string" || typeof code !== "string") {
      return NextResponse.json({ error: "token and code required", code: "invalid_argument" }, { status: 400 });
    }
    getDefaultOAuthLoginManager().submit(token, code);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}

// GET — SSE 事件流；断连即取消登录。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const manager = getDefaultOAuthLoginManager();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const emit = (event: OAuthClientEvent) => write("data: " + JSON.stringify(event) + "\n\n");

      const handle = manager.start(provider, emit);
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 浏览器或运行时可能已关闭。
        }
      };
      const cancel = () => {
        handle.abort();
        finish();
      };
      req.signal.addEventListener("abort", cancel, { once: true });
      void handle.done.finally(finish);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

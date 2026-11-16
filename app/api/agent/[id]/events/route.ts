import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { openSessionEventStream, parseLastEventId, SESSION_EVENT_HEARTBEAT_MS } from "@/lib/agent/session-events";
import { SessionManager } from "@earendil-works/pi-coding-agent";
export const dynamic = "force-dynamic";
// GET /api/agent/[id]/events — 会话事件 SSE。
// 流语义（先订阅后快照、缓冲去重、seq、重连 resync）由 lib/agent/session-events 统一实现。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    try {
      ({ session } = await startRpcSession(id, filePath, cwd));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false;
        }
      };
      write("retry: 1000\n\n");
      const events = openSessionEventStream(
        session,
        (event) => {
          write("id: " + event.seq + "\n" + "data: " + JSON.stringify(event) + "\n\n");
        },
        {
          lastEventId: parseLastEventId(req.headers.get("last-event-id")),
          heartbeatMs: SESSION_EVENT_HEARTBEAT_MS,
          onHeartbeat: () => { write(":\n\n"); },
        },
      );
      const close = () => {
        events.close();
        try { controller.close(); } catch { /* 已关闭 */ }
      };
      req.signal?.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

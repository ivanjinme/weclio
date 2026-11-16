import { isEventIncludedInSnapshot, toClientAgentEvent } from "../agent-event-wire";

// 会话事件流：宿主无关。每个订阅者先收到权威快照，再接实时增量；
// 订阅先于快照建立，发布期间的事件被缓冲，避免 delta 掉进重连缝隙。

export const SESSION_EVENT_HEARTBEAT_MS = 30_000;

export interface ClientSessionEvent {
  type: string;
  /** 同一订阅内的单调序号；客户端据此识别断档。 */
  seq: number;
  [key: string]: unknown;
}

export interface SessionEventSource {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly streamingMessage?: unknown;
  onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
}

export interface OpenSessionEventStreamOptions {
  /** 订阅序号起点；续订时可用于让客户端识别断档。 */
  startSeq?: number;
  /** 客户端上次收到的 seq；存在即表示这是一次重连。 */
  lastEventId?: number;
  heartbeatMs?: number;
  /** 心跳；默认发送 SSE 注释行。 */
  onHeartbeat?: () => void;
}

export interface SessionEventStream {
  /** 当前已发出的最大序号。 */
  readonly seq: number;
  /** 停止心跳与订阅；幂等。 */
  close(): void;
}

/**
 * 打开一条会话事件流。
 * 语义：
 * - 先订阅，再读快照；快照期间的事件缓冲，快照推送后按序补发；
 * - 快照已包含的 message_start/message_update 不重复发送；
 * - 重连（lastEventId 存在）时仍以快照为准：不承诺事件历史回放；
 * - 断连只释放订阅，不取消 Agent 执行。
 */
export function openSessionEventStream(
  session: SessionEventSource,
  emit: (event: ClientSessionEvent) => void,
  options: OpenSessionEventStreamOptions = {},
): SessionEventStream {
  let seq = options.startSeq ?? 0;
  const send = (event: { type: string } & Record<string, unknown>) => {
    emit({ ...event, seq: ++seq });
  };

  const snapshotState: { message?: unknown; published: boolean } = { published: false };
  const buffered: Array<{ type: string; [key: string]: unknown }> = [];
  const forward = (event: { type: string; [key: string]: unknown }) => {
    if (isEventIncludedInSnapshot(event, snapshotState.message)) return;
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent) send(clientEvent as unknown as { type: string } & Record<string, unknown>);
  };

  const unsubscribe = session.onEvent((event) => {
    if (!snapshotState.published) {
      buffered.push(event);
      return;
    }
    forward(event);
  });

  snapshotState.message = session.streamingMessage;
  send({
    type: "connected",
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    // 重连时提示客户端以快照为准重新对账，而不是假设事件连续。
    resync: options.lastEventId !== undefined,
  });
  if (snapshotState.message) send({ type: "message_start", message: snapshotState.message });
  snapshotState.published = true;
  for (const event of buffered) forward(event);
  buffered.length = 0;

  const heartbeatMs = options.heartbeatMs ?? SESSION_EVENT_HEARTBEAT_MS;
  const heartbeat = heartbeatMs > 0 ? setInterval(() => options.onHeartbeat?.(), heartbeatMs) : undefined;
  heartbeat?.unref?.();

  let closed = false;
  return {
    get seq() { return seq; },
    close() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    },
  };
}

/** 解析 Last-Event-ID；非法值视为没有续订。 */
export function parseLastEventId(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

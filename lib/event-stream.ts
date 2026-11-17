// 基于 fetch 流的 SSE 客户端，保留 EventSource 的重连语义并支持 Bearer 令牌。
import { agentAuthHeaders } from "./agent-credential";

export const EVENT_STREAM_CONNECTING = 0;
export const EVENT_STREAM_OPEN = 1;
export const EVENT_STREAM_CLOSED = 2;

export interface EventStreamMessage {
  data: string;
  lastEventId: string;
  type: string;
}

export interface EventStreamLike {
  readonly readyState: number;
  onmessage: ((event: EventStreamMessage) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onopen: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  close(): void;
}

interface MutableEventStream extends Omit<EventStreamLike, "readyState"> {
  readyState: number;
}

export interface EventStreamOptions {
  /** 断线重连时回传，服务端据此判断是否需要 resync。 */
  lastEventId?: string | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/** 建立可自动恢复的 SSE 连接；鉴权失败等非暂时性 HTTP 错误会终止连接。 */
export function createEventStream(url: string, options: EventStreamOptions = {}): EventStreamLike {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const listeners = new Map<string, Set<(event: never) => void>>();
  let lastEventId = options.lastEventId ?? "";
  const maxRetryDelay = Number.isFinite(options.maxRetryDelayMs)
    ? Math.max(1, Math.min(options.maxRetryDelayMs!, 2_147_483_647)) : 30_000;
  const boundDelay = (delay: number) => Math.max(1, Math.min(delay, maxRetryDelay));
  let retryDelay = boundDelay(Number.isFinite(options.retryDelayMs) ? options.retryDelayMs! : 1000);
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortOnSignal = () => stream.close();

  const stream: MutableEventStream = {
    readyState: EVENT_STREAM_CONNECTING,
    onmessage: null,
    onerror: null,
    onopen: null,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    close() {
      if (stopped) return;
      stopped = true;
      stream.readyState = EVENT_STREAM_CLOSED;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortOnSignal);
      controller.abort();
      // 自定义 fetch 也可能不响应 AbortSignal，因此显式取消 reader。
      void reader?.cancel().catch(() => {});
    },
  };

  const dispatch = (type: string, event: unknown) => {
    if (stopped) return;
    if (type === "message") stream.onmessage?.(event as EventStreamMessage);
    else if (type === "error") stream.onerror?.(event);
    else if (type === "open") stream.onopen?.(event);
    for (const listener of listeners.get(type) ?? []) {
      if (stopped) break;
      (listener as (payload: unknown) => void)(event);
    }
  };

  const retry = (error: unknown) => {
    if (stopped) return;
    stream.readyState = EVENT_STREAM_CONNECTING;
    dispatch("error", error);
    if (!stopped) timer = setTimeout(() => { timer = null; void connect(); }, retryDelay);
  };

  const connect = async () => {
    if (stopped) return;
    const headers = agentAuthHeaders(url, options.headers);
    headers.set("accept", "text/event-stream");
    // 空 id 字段也必须清除先前的游标（包括调用方提供的头）。
    headers.delete("last-event-id");
    if (lastEventId) headers.set("last-event-id", lastEventId);

    try {
      const response = await fetchImpl(url, {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      if (stopped) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || response.status === 204 || !response.body) {
        // 取消响应体失败不能把鉴权等终止性 HTTP 错误变成重试。
        await response.body?.cancel().catch(() => {});
        const error = { status: response.status };
        if (response.status >= 500 && response.status <= 599) retry(error);
        else {
          stream.readyState = EVENT_STREAM_CLOSED;
          try { dispatch("error", error); } finally { stream.close(); }
        }
        return;
      }

      reader = response.body.getReader();
      stream.readyState = EVENT_STREAM_OPEN;
      dispatch("open", { readyState: stream.readyState });
      const decoder = new TextDecoder();
      let line = "";
      let skipLF = false;
      let data: string[] = [];
      let eventType = "";
      let idBuffer = lastEventId;
      const consumeLine = () => {
        if (!line) {
          lastEventId = idBuffer;
          if (data.length) {
            const type = eventType || "message";
            dispatch(type, { data: data.join("\n"), lastEventId, type });
          }
          data = [];
          eventType = "";
          return;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") eventType = value;
        else if (field === "id" && !value.includes("\0")) idBuffer = value;
        else if (field === "retry" && /^\d+$/.test(value)) retryDelay = boundDelay(Number(value));
        line = "";
      };
      for (;;) {
        if (stopped) return;
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) break;
        for (const char of decoder.decode(value, { stream: true })) {
          if (stopped) return;
          if (skipLF && char === "\n") { skipLF = false; continue; }
          skipLF = char === "\r";
          if (char === "\r" || char === "\n") consumeLine();
          else line += char;
        }
      }
      // EOF 不提交未以空行结束的帧，但必须恢复旁栏/文件监视等长连接。
      retry({ readyState: EVENT_STREAM_CONNECTING });
    } catch (error) {
      retry(error);
    } finally {
      reader?.releaseLock();
      reader = null;
    }
  };

  if (options.signal?.aborted) stream.close();
  else {
    options.signal?.addEventListener("abort", abortOnSignal, { once: true });
    void connect();
  }
  return stream;
}

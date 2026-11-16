// 基于 fetch 流的 SSE 客户端，替代 EventSource。
// 原因：EventSource 不能带请求头，连独立 Agent Service 时无法附 Bearer 令牌。
// 对外刻意保持 EventSource 的常用形状（onmessage/onerror/onopen/readyState/close），
// 调用点的改动因此只有一行；重连仍由调用方按原逻辑决定。
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

/** 内部可变视图：readyState 需要由实现推进，对外仍是只读。 */
interface MutableEventStream extends Omit<EventStreamLike, "readyState"> {
  readyState: number;
}

export interface EventStreamOptions {
  /** 断线重连时回传，服务端据此判断是否需要 resync。 */
  lastEventId?: string | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 建立一条 SSE 连接；返回对象与 EventSource 用法兼容。 */
export function createEventStream(url: string, options: EventStreamOptions = {}): EventStreamLike {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const listeners = new Map<string, Set<(event: never) => void>>();
  let lastEventId = options.lastEventId ?? "";

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
      if (stream.readyState === EVENT_STREAM_CLOSED) return;
      stream.readyState = EVENT_STREAM_CLOSED;
      controller.abort();
    },
  };

  const dispatch = (type: string, event: unknown) => {
    if (type === "message") stream.onmessage?.(event as EventStreamMessage);
    else if (type === "error") stream.onerror?.(event);
    else if (type === "open") stream.onopen?.(event);
    for (const listener of listeners.get(type) ?? []) {
      (listener as (payload: unknown) => void)(event);
    }
  };

  const fail = (error: unknown) => {
    if (stream.readyState === EVENT_STREAM_CLOSED) return;
    stream.readyState = EVENT_STREAM_CLOSED;
    dispatch("error", error);
  };

  const abortOnSignal = () => stream.close();
  options.signal?.addEventListener("abort", abortOnSignal, { once: true });

  void (async () => {
    const headers = agentAuthHeaders(options.headers);
    headers.set("accept", "text/event-stream");
    if (lastEventId) headers.set("last-event-id", lastEventId);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (stream.readyState !== EVENT_STREAM_CLOSED) fail(error);
      return;
    }

    if (!response.ok || !response.body) {
      fail({ status: response.status });
      return;
    }

    stream.readyState = EVENT_STREAM_OPEN;
    dispatch("open", { readyState: stream.readyState });

    const decoder = new TextDecoder();
    let buffer = "";
    const emit = (block: string) => {
      const data: string[] = [];
      let type = "message";
      let id: string | null = null;
      for (const rawLine of block.split("\n")) {
        if (!rawLine || rawLine.startsWith(":")) continue;
        const colon = rawLine.indexOf(":");
        const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
        const value = colon < 0 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "id") id = value;
        else if (field === "event") type = value;
      }
      // 纯注释块（心跳）没有数据。
      if (data.length === 0) return;
      if (id !== null) lastEventId = id;
      dispatch(type, { data: data.join("\n"), lastEventId, type });
    };

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
          emit(block.replace(/\r/g, ""));
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
      // 服务端正常关闭时也要让调用方有机会重连。
      if (stream.readyState !== EVENT_STREAM_CLOSED) {
        stream.readyState = EVENT_STREAM_CLOSED;
        dispatch("error", { readyState: stream.readyState });
      }
    } catch (error) {
      if (stream.readyState !== EVENT_STREAM_CLOSED) fail(error);
    }
  })();

  return stream;
}

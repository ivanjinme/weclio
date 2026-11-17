import { apiUrl } from "./api-base";
import { apiFetch } from "./api-fetch";
import { encodeFilePathForApi, getFileName } from "./file-paths";

export type ResourceKind = "read" | "preview" | "download";
export interface ResourceRequest {
  filePath: string;
  kind: ResourceKind;
  sessionId?: string | null;
  revision?: string | number;
  source?: "bash-output";
}
export interface ResourceLease {
  url: string;
  transport: "blob" | "ticket";
  expiresAt?: number;
  release(): void;
}
export interface ResourceOptions {
  signal?: AbortSignal;
  /** PDF、音视频和下载直接使用原生流，不预取完整内容。 */
  native?: boolean;
}
export const RESOURCE_BLOB_MAX_BYTES = 2 * 1024 * 1024;

export function fileResourceApiUrl(request: ResourceRequest): string {
  if (request.source === "bash-output") {
    return apiUrl(`/agent/${encodeURIComponent(request.sessionId ?? "")}/bash-output?path=${encodeURIComponent(request.filePath)}&download=1`);
  }
  const params = new URLSearchParams({ type: request.kind });
  if (request.sessionId) params.set("sessionId", request.sessionId);
  if (request.revision !== undefined) params.set("v", String(request.revision));
  return apiUrl(`/files/${encodeFilePathForApi(request.filePath)}?${params}`);
}

class ResourceRequestError extends Error {}

function checkResponse(response: Response): void {
  // 不把响应 URL 或票据写进异常/日志。
  if (!response.ok) throw new ResourceRequestError(`Resource request failed (HTTP ${response.status})`);
}

/** 即使 meta 已检查，传输中仍限制字节数，避免文件变化导致整份大文件进入 Blob。 */
async function boundedBlob(response: Response, signal?: AbortSignal): Promise<Blob | null> {
  if (Number(response.headers.get("content-length")) > RESOURCE_BLOB_MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: response.headers.get("content-type") ?? "" });
  const chunks: BlobPart[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > RESOURCE_BLOB_MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value.slice().buffer);
    }
    return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function acquireResource(request: ResourceRequest, options: ResourceOptions = {}): Promise<ResourceLease> {
  try { return await acquire(request, options); } catch (error) {
    if (options.signal?.aborted) throw new DOMException("Resource request aborted", "AbortError");
    if (error instanceof ResourceRequestError) throw error;
    throw new ResourceRequestError("Resource request failed");
  }
}

async function acquire(request: ResourceRequest, options: ResourceOptions): Promise<ResourceLease> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (request.source === "bash-output" && (request.kind !== "download" || !request.sessionId)) {
    throw new ResourceRequestError("Bash output download requires a session");
  }
  // SVG 的安全响应头不能随着 Blob 继承，保留原生 URL + 服务端 CSP。
  const allowBlob = !options.native && request.kind !== "download" && !/\.svg$/i.test(request.filePath);
  if (allowBlob) {
    const params = new URLSearchParams({ type: "meta" });
    if (request.sessionId) params.set("sessionId", request.sessionId);
    const meta = await apiFetch(`/files/${encodeFilePathForApi(request.filePath)}?${params}`, { signal });
    checkResponse(meta);
    const value: unknown = await meta.json();
    const size = value && typeof value === "object" && "size" in value ? value.size : undefined;
    if (typeof size === "number" && size >= 0 && size <= RESOURCE_BLOB_MAX_BYTES) {
      const response = await apiFetch(fileResourceApiUrl(request), { signal });
      checkResponse(response);
      const blob = await boundedBlob(response, signal);
      signal?.throwIfAborted();
      if (blob) {
        const url = URL.createObjectURL(blob);
        let released = false;
        return { url, transport: "blob", release() { if (!released) { released = true; URL.revokeObjectURL(url); } } };
      }
    }
  }

  const response = await apiFetch("/resources/tickets", {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ filePath: request.filePath, kind: request.kind, sessionId: request.sessionId, source: request.source }),
  });
  checkResponse(response);
  const issued: unknown = await response.json();
  signal?.throwIfAborted();
  if (!issued || typeof issued !== "object" || !("ticket" in issued) || !("expiresAt" in issued)
    || typeof issued.ticket !== "string" || !issued.ticket || issued.ticket.length > 16 * 1024
    || typeof issued.expiresAt !== "number" || !Number.isFinite(issued.expiresAt) || issued.expiresAt <= Date.now()) {
    throw new ResourceRequestError("Invalid resource ticket response");
  }
  return {
    url: apiUrl(`/resources/content?ticket=${encodeURIComponent(issued.ticket)}`),
    transport: "ticket", expiresAt: issued.expiresAt, release() {},
  };
}

/** 每次点击新签发，避免下载链接在长时间打开的页面里提前过期。 */
export async function downloadResource(filePath: string, sessionId?: string | null, options: { source?: "bash-output"; signal?: AbortSignal } = {}): Promise<void> {
  const resource = await acquireResource({ filePath, kind: "download", sessionId, source: options.source }, { native: true, signal: options.signal });
  try {
    options.signal?.throwIfAborted();
    // Desktop 主窗口禁止跨源导航；只把已签发的票据交给宿主下载，不改变资源授权流程。
    if (typeof window !== "undefined" && window.weclioDesktop?.downloadResource) {
      try { await window.weclioDesktop.downloadResource(resource.url); }
      catch { throw new ResourceRequestError("Resource download failed"); }
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = resource.url;
    anchor.download = getFileName(filePath);
    anchor.referrerPolicy = "no-referrer";
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally { resource.release(); }
}

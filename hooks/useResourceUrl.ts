"use client";

import { useCallback, useEffect, useState } from "react";
import { acquireResource, type ResourceLease, type ResourceOptions, type ResourceRequest } from "@/lib/resource-client";

/** 每个挂载视图持有自己的 Blob 生命周期；切换资源时不显示旧 URL。 */
export function useResourceUrl(request: ResourceRequest, options: Pick<ResourceOptions, "native"> = {}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const key = JSON.stringify([request.filePath, request.kind, request.sessionId, request.revision, request.source, options.native, refreshKey]);
  const [state, setState] = useState<{ key: string; resource?: ResourceLease; error?: string }>({ key: "" });
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);
  const { filePath, kind, sessionId, revision, source } = request;
  const native = options.native;

  useEffect(() => {
    const controller = new AbortController();
    let lease: ResourceLease | undefined;
    void acquireResource({ filePath, kind, sessionId, revision, ...(source ? { source } : {}) }, { native, signal: controller.signal })
      .then((resource) => {
        lease = resource;
        if (controller.signal.aborted) { resource.release(); return; }
        setState({ key, resource });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "Resource request failed" });
      });
    return () => { controller.abort(); lease?.release(); };
  }, [filePath, kind, sessionId, revision, source, native, key]);

  return { url: state.key === key ? state.resource?.url : undefined,
    error: state.key === key ? state.error : undefined,
    expiresAt: state.key === key ? state.resource?.expiresAt : undefined, refresh };
}

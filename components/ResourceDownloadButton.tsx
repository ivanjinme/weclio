"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { downloadResource } from "@/lib/resource-client";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  filePath: string;
  sessionId?: string | null;
  source?: "bash-output";
};

export function ResourceDownloadButton({ filePath, sessionId, source, children, onClick, title, disabled, ...props }: Props) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setBusy(false);
    setError(undefined);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [filePath, sessionId, source]);
  return <button {...props} type="button" disabled={disabled || busy} aria-busy={busy}
    title={error ?? title} onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError(undefined);
      void downloadResource(filePath, sessionId, { source, signal: controller.signal })
        .catch(() => { if (!controller.signal.aborted) setError("Download failed. Click to retry."); })
        .finally(() => {
          if (pending.current !== controller) return;
          pending.current = null;
          setBusy(false);
        });
    }}>{children}</button>;
}

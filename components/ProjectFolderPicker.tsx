"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/api-base";
import { apiFetch } from "@/lib/api-fetch";
import { PROJECT_FOLDER_CONFIRMED_EVENT } from "@/lib/project-folders";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectTrustDialog } from "./ProjectTrustDialog";

interface Props {
  onCancel: () => void;
  onSelect: (cwd: string) => void;
}

export function ProjectFolderPicker({ onCancel, onSelect }: Props) {
  const [pendingCwd, setPendingCwd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => requestRef.current?.abort(), []);

  useLayoutEffect(() => {
    // 弹窗打开时，Esc 只关闭弹窗，不中断会话。
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!requestRef.current) onCancel();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onCancel]);

  async function confirm(cwd: string) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError(null);
    let selectedCwd: string;
    try {
      const response = await apiFetch(apiUrl("/projects/select"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null) as {
        cwd?: string;
        error?: { message?: string } | string;
      } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || typeof data?.cwd !== "string" || !data.cwd) {
        const error = data?.error;
        throw new Error((typeof error === "string" ? error : error?.message) ?? `HTTP ${response.status}`);
      }
      selectedCwd = data.cwd;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      return;
    } finally {
      requestRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
    onSelect(selectedCwd);
    window.dispatchEvent(new CustomEvent(PROJECT_FOLDER_CONFIRMED_EVENT, { detail: selectedCwd }));
  }

  if (!pendingCwd) return <DirectoryPicker onCancel={onCancel} onSelect={setPendingCwd} />;

  return createPortal(
    <ProjectTrustDialog
      cwd={pendingCwd}
      busy={busy}
      error={error}
      autoFocusCancel
      onCancel={() => { if (!requestRef.current) onCancel(); }}
      onConfirm={() => void confirm(pendingCwd)}
    />,
    document.body,
  );
}

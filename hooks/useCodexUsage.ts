"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api-base";
import type { CodexUsage } from "@/lib/codex-usage";

export function useCodexUsage(menuOpen: boolean) {
  const [usage, setUsage] = useState<CodexUsage | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(apiUrl("/usage/codex"), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Usage unavailable");
        const data = await response.json() as CodexUsage;
        if (active) setUsage(data);
      } catch {
        if (active) setUsage({ status: "unavailable" });
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [menuOpen]);

  return usage;
}

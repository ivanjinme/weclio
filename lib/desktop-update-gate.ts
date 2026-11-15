import { getDefaultAdmission } from "./agent/admission";

declare global {
  var __weclioDesktopUpdateGate: { registered: boolean } | undefined;
}

function gate() {
  return getDefaultAdmission();
}

// 在首个 await 前占位，覆盖 SDK 尚未设置运行标记的窗口。
export function beginDesktopTask(): () => void {
  return gate().reserve();
}

export function desktopUpdateStatus(lock: boolean, isBusy: () => boolean): "ready" | "busy" {
  if (lock) return gate().tryLock(isBusy) ? "ready" : "busy";
  return gate().isBusy(isBusy) ? "busy" : "ready";
}

export function unlockDesktopUpdate(): void {
  gate().unlock();
}

export function registerDesktopUpdateGate(isBusy: () => boolean): void {
  if (process.env.NODE_ENV !== "production" || process.env.WECLIO_DESKTOP_UPDATE_IPC !== "1" || !process.send || !process.connected) return;
  const state = globalThis.__weclioDesktopUpdateGate ??= { registered: false };
  if (state.registered) return;
  state.registered = true;
  // 同一有序通道内同步处理；lock/unlock 之间不能插入异步加载。
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as Record<string, unknown>;
    if (request.type !== "weclio-desktop-update" || typeof request.id !== "string") return;
    if (request.action !== "inspect" && request.action !== "lock" && request.action !== "unlock") return;
    if (request.action === "unlock") unlockDesktopUpdate();
    const status = request.action === "unlock" ? "ready" : desktopUpdateStatus(request.action === "lock", isBusy);
    if (process.connected) process.send?.({ type: "weclio-desktop-update-result", id: request.id, status }, (error) => {
      if (error) unlockDesktopUpdate();
    });
  });
  process.once("disconnect", unlockDesktopUpdate);
}

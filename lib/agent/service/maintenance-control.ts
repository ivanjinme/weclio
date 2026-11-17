import type { AgentRuntime } from "../../rpc-manager";

type MaintenanceRuntime = Pick<AgentRuntime, "admission" | "hasBusyTasks">;
export interface MaintenanceReply {
  id: number;
  status: "ready" | "busy" | "unlocked" | "error";
}

/** 仅用于宿主拥有的 stdin 管道，不注册 HTTP 管理接口或借用业务 Bearer。 */
export function handleMaintenanceLine(runtime: MaintenanceRuntime, line: string): MaintenanceReply | undefined {
  let input: unknown;
  try { input = JSON.parse(line); } catch { return; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const request = input as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 1) return;
  const id = request.id as number;
  const busy = () => runtime.hasBusyTasks();
  // inspect/lock 在同一同步调用内检查，不能在检查与锁定之间 await。
  switch (request.action) {
    case "inspect": return { id, status: runtime.admission.isBusy(busy) ? "busy" : "ready" };
    case "lock": return { id, status: runtime.admission.tryLock(busy) ? "ready" : "busy" };
    case "unlock": runtime.admission.unlock(); return { id, status: "unlocked" };
    default: return { id, status: "error" };
  }
}

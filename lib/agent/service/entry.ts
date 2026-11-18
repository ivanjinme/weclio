import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getGlobalDispatcher } from "undici";
import { AgentRuntime } from "../../rpc-manager";
import { configureHttpDispatcher } from "../../http-dispatcher";
import { PROTOCOL_VERSION } from "../protocol/version";
import { resolveServiceConfig, resolveStateDir, type ServiceConfig } from "./config";
import { acquireServiceOwnership } from "./ownership";
import { startAgentServiceHost, type AgentServiceHost } from "./host";
import { handleMaintenanceLine } from "./maintenance-control";

const IDENTITY_FILE = "service.json";
const OWNER_FILE = "owner.json";

interface ServiceIdentity {
  version: 1;
  serviceId: string;
  instanceId: string;
  protocolVersion: number;
  pid: number;
  url: string;
}

interface OwnerRecord {
  pid: number;
  instanceId: string;
}

export interface StartedAgentService {
  config: ServiceConfig;
  serviceId: string;
  instanceId: string;
  url: string;
  runtime: AgentRuntime;
  close(): Promise<{ timedOut: boolean }>;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function resolveServiceId(stateDir: string): string {
  const path = join(stateDir, IDENTITY_FILE);
  const existing = readJson<Partial<ServiceIdentity>>(path);
  return typeof existing?.serviceId === "string" && existing.serviceId ? existing.serviceId : randomUUID();
}

async function startAgentService(initialize?: () => Promise<unknown>): Promise<StartedAgentService> {
  const stateDir = resolveStateDir();
  const release = await acquireServiceOwnership([getAgentDir(), stateDir]);
  const instanceId = randomUUID();
  const ownerPath = join(stateDir, OWNER_FILE);
  let published = false;
  async function releaseOwner() {
    try {
      if (published) rmSync(ownerPath, { force: true });
    } finally { await release(); }
  }
  let host: AgentServiceHost | undefined;
  try {
    const config = resolveServiceConfig();
    await initialize?.();
    configureHttpDispatcher();
    const serviceId = resolveServiceId(stateDir);
    const runtime = new AgentRuntime();
    const started = host = await startAgentServiceHost({
      runtime, config, serviceId, instanceId,
      appVersion: process.env.WECLIO_AGENT_VERSION ?? "0.0.0-dev",
    });
    const identity: ServiceIdentity = {
      version: 1, serviceId, instanceId, protocolVersion: PROTOCOL_VERSION, pid: process.pid, url: started.url,
    };
    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, instanceId } satisfies OwnerRecord));
    published = true;
    writeFileSync(join(stateDir, IDENTITY_FILE), JSON.stringify(identity, null, 2) + "\n");
    let closing: Promise<{ timedOut: boolean }> | undefined;
    return {
      config, serviceId, instanceId, url: started.url, runtime,
      close() {
        return closing ??= (async () => {
          await started.close();
          const result = await runtime.drain(config.drainTimeoutMs);
          // 超时后仍可能有写入；让进程退出释放 OS 锁。
          if (!result.timedOut) await releaseOwner();
          return result;
        })();
      },
    };
  } catch (error) {
    try { await host?.close(); }
    finally { await releaseOwner(); }
    throw error;
  }
}

/** 独立进程入口：就绪/关闭各输出一行机器可读事件，生命周期不依赖客户端连接。 */
export async function main(initialize?: () => Promise<unknown>): Promise<void> {
  let service: StartedAgentService;
  try {
    service = await startAgentService(initialize);
  } catch (error) {
    // 所有权冲突等启动失败必须是一行可操作信息，而不是崩溃堆栈。
    console.error(`[agent-service] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  process.stdout.write(`WECLIO_AGENT_READY ${JSON.stringify({
    url: service.url,
    serviceId: service.serviceId,
    instanceId: service.instanceId,
  })}\n`);

  let closing = false;
  const shutdown = async (reason: "signal" | "control") => {
    if (closing) return;
    closing = true;
    control.close();
    process.stdin.destroy();
    try {
      const { timedOut } = await service.close();
      if (!timedOut) await getGlobalDispatcher().destroy();
      process.stdout.write(`WECLIO_AGENT_CLOSED ${JSON.stringify({ reason, timedOut })}\n`);
      if (timedOut) process.exit(1);
      // 正常停服让 Node 完成原生资源清理，避免 Windows 上强退触发 libuv 断言。
      process.exitCode = 0;
    } catch (error) {
      console.error("[agent-service] shutdown failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => { void shutdown("signal"); });
  process.once("SIGINT", () => { void shutdown("signal"); });
  // Windows 没有可等待的 SIGTERM；标准输入上的显式控制行是可移植的停止路径。
  const managed = process.env.WECLIO_AGENT_PARENT_STDIN === "1";
  // readline 保留跨 chunk 的完整行，不能把半条 JSON/关停命令当成另一条请求。
  const control = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  control.on("line", (line: string) => {
    if (line.trim() === "shutdown") { void shutdown("control"); return; }
    if (!managed || closing) return;
    const reply = handleMaintenanceLine(service.runtime, line);
    if (reply) process.stdout.write(`WECLIO_AGENT_CONTROL ${JSON.stringify(reply)}\n`);
  });
  // 只有受 Desktop 管理的实例才把父进程控制管道关闭视为退出；独立部署不能依赖 stdin。
  if (managed) control.once("close", () => { void shutdown("control"); });
}

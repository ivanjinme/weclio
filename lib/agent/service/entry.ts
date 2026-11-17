import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../../rpc-manager";
import { configureHttpDispatcher } from "../../http-dispatcher";
import { PROTOCOL_VERSION } from "../protocol/version";
import { resolveServiceConfig, type ServiceConfig } from "./config";
import { startAgentServiceHost, type AgentServiceHost } from "./host";

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 同一状态目录只允许一个写入者；残留记录只有在属主进程确实不存在时才被接管。 */
function claimOwner(stateDir: string, instanceId: string): () => void {
  const path = join(stateDir, OWNER_FILE);
  const existing = readJson<OwnerRecord>(path);
  if (existing && existing.pid !== process.pid && processAlive(existing.pid)) {
    throw new Error(`Another agent service already owns ${stateDir} (pid ${existing.pid})`);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, instanceId } satisfies OwnerRecord));
  return () => {
    const current = readJson<OwnerRecord>(path);
    if (current?.instanceId === instanceId) rmSync(path, { force: true });
  };
}

function resolveServiceId(stateDir: string): string {
  const path = join(stateDir, IDENTITY_FILE);
  const existing = readJson<Partial<ServiceIdentity>>(path);
  return typeof existing?.serviceId === "string" && existing.serviceId ? existing.serviceId : randomUUID();
}

export async function startAgentService(
  options: { env?: NodeJS.ProcessEnv; appVersion?: string } = {},
): Promise<StartedAgentService> {
  const env = options.env ?? process.env;
  const config = resolveServiceConfig(env);
  configureHttpDispatcher();
  mkdirSync(config.stateDir, { recursive: true });

  const instanceId = randomUUID();
  const releaseOwner = claimOwner(config.stateDir, instanceId);
  const serviceId = resolveServiceId(config.stateDir);
  const runtime = new AgentRuntime();
  let host: AgentServiceHost;
  try {
    host = await startAgentServiceHost({
      runtime,
      config,
      serviceId,
      instanceId,
      appVersion: options.appVersion ?? env.WECLIO_AGENT_VERSION ?? "0.0.0-dev",
    });
  } catch (error) {
    releaseOwner();
    throw error;
  }

  const identity: ServiceIdentity = {
    version: 1,
    serviceId,
    instanceId,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    url: host.url,
  };
  writeFileSync(join(config.stateDir, IDENTITY_FILE), JSON.stringify(identity, null, 2) + "\n");

  let closed = false;
  return {
    config,
    serviceId,
    instanceId,
    url: host.url,
    runtime,
    async close() {
      if (closed) return { timedOut: false };
      closed = true;
      try {
        await host.close();
        return await runtime.drain(config.drainTimeoutMs);
      } finally {
        releaseOwner();
      }
    },
  };
}

/** 独立进程入口：就绪/关闭各输出一行机器可读事件，生命周期不依赖客户端连接。 */
export async function main(): Promise<void> {
  const service = await startAgentService();
  process.stdout.write(`WECLIO_AGENT_READY ${JSON.stringify({
    url: service.url,
    serviceId: service.serviceId,
    instanceId: service.instanceId,
  })}\n`);

  let closing = false;
  const shutdown = async (reason: "signal" | "control") => {
    if (closing) return;
    closing = true;
    try {
      const { timedOut } = await service.close();
      process.stdout.write(`WECLIO_AGENT_CLOSED ${JSON.stringify({ reason, timedOut })}\n`);
      process.exit(timedOut ? 1 : 0);
    } catch (error) {
      console.error("[agent-service] shutdown failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => { void shutdown("signal"); });
  process.once("SIGINT", () => { void shutdown("signal"); });
  // Windows 没有可等待的 SIGTERM；标准输入上的显式控制行是可移植的停止路径。
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk.split(/\r?\n/).some((line) => line.trim() === "shutdown")) void shutdown("control");
  });
  // 只有受 Desktop 管理的实例才把父进程控制管道关闭视为退出；独立部署不能依赖 stdin。
  if (process.env.WECLIO_AGENT_PARENT_STDIN === "1") process.stdin.once("end", () => { void shutdown("control"); });
  process.stdin.resume();
}

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getDefaultWorkspacePath } from "../../default-workspace";

export interface ServiceConfig {
  host: string;
  port: number;
  stateDir: string;
  workspace: string;
  token: string;
  drainTimeoutMs: number;
}

export const TOKEN_FILE = "service-token";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function readToken(path: string): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 引导令牌：优先进程给定的受保护文件，其次本机首次生成并限制为属主可读。 */
function resolveToken(stateDir: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.WECLIO_AGENT_TOKEN_FILE;
  if (explicit) {
    const token = readToken(absolutePath(explicit, "WECLIO_AGENT_TOKEN_FILE"));
    if (!token) throw new Error(`Agent token file is empty: ${explicit}`);
    return token;
  }
  const path = join(stateDir, TOKEN_FILE);
  const existing = readToken(path);
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return token;
}

function resolvePort(value: string | undefined): number {
  const port = Number(value ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid WECLIO_AGENT_PORT: ${value}`);
  return port;
}

export function resolveServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const stateDir = absolutePath(env.WECLIO_AGENT_STATE_DIR ?? join(homedir(), ".weclio", "agent-service"), "WECLIO_AGENT_STATE_DIR");
  const workspace = absolutePath(env.WECLIO_AGENT_WORKSPACE ?? getDefaultWorkspacePath(env.WECLIO_DEFAULT_CWD ?? ""), "WECLIO_AGENT_WORKSPACE");
  const host = env.WECLIO_AGENT_HOST ?? "127.0.0.1";
  // Remote 是延期阶段；先把地址限制在回环，避免误暴露 shell 能力。
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`Remote binding is not supported yet: ${host}`);
  const drainTimeoutMs = Number(env.WECLIO_AGENT_DRAIN_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs <= 0) throw new Error("Invalid WECLIO_AGENT_DRAIN_TIMEOUT_MS");

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return {
    host,
    port: resolvePort(env.WECLIO_AGENT_PORT),
    stateDir,
    workspace,
    token: resolveToken(stateDir, env),
    drainTimeoutMs,
  };
}

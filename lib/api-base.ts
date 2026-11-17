// API 基址：当前默认同源 `/api`，行为与拆分前完全一致。
// Desktop/Remote 需要指向别的 Agent Service 时，在启动阶段调用 configureApiBase()，
// 所有经 apiUrl() 的调用点自动跟随，不需要改组件。

import { resolveApiPath, resolveHostProfile } from "./agent/routes";

export interface ApiBaseConfig {
  /** 服务源，例如 https://vm.example:8443；留空表示同源。 */
  baseUrl?: string;
  /** 路由前缀，默认 /api。 */
  basePath?: string;
}

const DEFAULT_BASE_PATH = "/api";

let current: Required<ApiBaseConfig> = { baseUrl: "", basePath: DEFAULT_BASE_PATH };

export function configureApiBase(config: ApiBaseConfig): void {
  const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "");
  const rawPath = config.basePath ?? DEFAULT_BASE_PATH;
  if (!rawPath.startsWith("/")) throw new Error(`basePath must start with "/": ${rawPath}`);
  current = { baseUrl, basePath: rawPath.replace(/\/+$/, "") || DEFAULT_BASE_PATH };
}

export function getApiBase(): Required<ApiBaseConfig> {
  return { ...current };
}

/** 还原默认同源配置；测试与开发热重载使用。 */
export function resetApiBase(): void {
  current = { baseUrl: "", basePath: DEFAULT_BASE_PATH };
}

/**
 * 把 `/agent/x` 这类以 `/` 开头的路径拼到配置的基址上。
 * 已经是绝对 URL 的输入原样返回，避免重复拼接。
 */
export function apiUrl(path: string, method = "GET"): string {
  if (/^[a-z]+:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  // 幂等：已经带基址的路径不再重复拼接，嵌套调用 apiFetch(apiUrl(x)) 安全。
  if (current.basePath !== "/" && (normalized === current.basePath || normalized.startsWith(`${current.basePath}/`))) {
    return `${current.baseUrl}${normalized}`;
  }
  return `${current.baseUrl}${current.basePath}${resolveApiPath(normalized, resolveHostProfile(current.basePath), method)}`;
}

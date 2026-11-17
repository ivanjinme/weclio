// API 基址必须在 UI 挂载前显式选择；未配置时禁止回落到 UI 同源后端。
import { resolveApiPath, validateServiceBasePath } from "./agent/routes";

export interface ApiBaseConfig {
  /** 服务源，例如 https://vm.example:8443；显式留空表示同源。 */
  baseUrl?: string;
  /** Service 路由前缀，默认 /v1。 */
  basePath?: string;
}

const DEFAULT_BASE_PATH = "/v1";
let current: Required<ApiBaseConfig> = { baseUrl: "", basePath: DEFAULT_BASE_PATH };
let configured = false;

export function configureApiBase(config: ApiBaseConfig): void {
  const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "");
  const rawPath = config.basePath ?? DEFAULT_BASE_PATH;
  validateServiceBasePath(rawPath);
  current = { baseUrl, basePath: rawPath.replace(/\/+$/, "") || DEFAULT_BASE_PATH };
  configured = true;
}

export function isApiBaseConfigured(): boolean {
  return configured;
}

export function requireApiBaseConfigured(): void {
  if (!configured) throw new Error("Agent Service is not configured");
}

export function getApiBase(): Required<ApiBaseConfig> {
  return { ...current };
}

/** 清除选定的 Service；测试与开发热重载使用。 */
export function resetApiBase(): void {
  current = { baseUrl: "", basePath: DEFAULT_BASE_PATH };
  configured = false;
}

/** 历史 UI 路径在客户端转换；绝对 URL 保留给显式调用方。 */
export function apiUrl(path: string, method = "GET"): string {
  if (/^[a-z]+:\/\//i.test(path)) return path;
  requireApiBaseConfigured();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  // 嵌套调用 apiFetch(apiUrl(x)) 不重复拼接。
  if (current.basePath !== "/" && (normalized === current.basePath || normalized.startsWith(`${current.basePath}/`))) {
    return `${current.baseUrl}${normalized}`;
  }
  return `${current.baseUrl}${current.basePath}${resolveApiPath(normalized, method)}`;
}

// 统一的请求出口：拼基址 + 补 Bearer 令牌。
// 组件不该各自 fetch 裸 URL，否则连到 Service 时会缺 Authorization。
import { apiUrl } from "./api-base";
import { agentAuthHeaders, hasAgentCredential } from "./agent-credential";

export interface ApiFetchInit extends RequestInit {
  /** 允许调用方跳过令牌注入（例如匿名健康检查）。 */
  anonymous?: boolean;
}

/** 发起请求；path 可以是相对基址的路径，也可以是已经拼好的绝对 URL。 */
export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  const { anonymous, headers, ...rest } = init;
  const resolved = /^(?:[a-z]+:)?\/\//i.test(path) ? path : apiUrl(path);
  return fetch(resolved, {
    ...rest,
    headers: !anonymous && hasAgentCredential() ? agentAuthHeaders(resolved, headers) : headers,
  });
}

/** 读取 JSON；非 2xx 抛出带状态码的错误，方便调用点统一处理 401。 */
export async function apiFetchJson<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(text || `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return await response.json() as T;
}

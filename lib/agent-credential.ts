// Agent Service 凭据：只在内存持有，由可信宿主通道注入。
// Desktop 走 preload，Web 走服务端注入，本地开发走环境变量；不落 Cookie、不进 URL。
// 当前采用显式 Bearer，不依赖跨站 Cookie；原生媒体/下载的认证通道另行决策。

import { getApiBase, isApiBaseConfigured } from "./api-base";

let credential: string | null = null;

/** 设置/清除当前会话的 Bearer 令牌；传空值表示匿名（同源 Next 宿主）。 */
export function setAgentCredential(token: string | null | undefined): void {
  const trimmed = typeof token === "string" ? token.trim() : "";
  credential = trimmed ? trimmed : null;
}

export function getAgentCredential(): string | null {
  return credential;
}

export function hasAgentCredential(): boolean {
  return credential !== null;
}

function isSelectedApiUrl(url: string): boolean {
  if (!isApiBaseConfigured()) return false;
  // 不为协议相对地址或反斜杠地址推断凭据归属。
  if (url.trimStart().startsWith("//") || url.includes("\\")) return false;
  const { baseUrl, basePath } = getApiBase();
  const origin = typeof location !== "undefined" && /^https?:$/.test(location.protocol)
    ? location.origin : undefined;
  if (!baseUrl && !origin && !url.startsWith("/")) return false;
  try {
    const base = new URL(`${baseUrl}${basePath}`, origin ?? "http://agent.invalid");
    const target = new URL(url, origin ?? base.origin);
    const prefix = base.pathname.replace(/\/+$/, "");
    return /^https?:$/.test(base.protocol) && target.origin === base.origin
      && (target.pathname === prefix || target.pathname.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

/** 只为当前 API 源及路由前缀补齐 Authorization；显式头不覆盖。 */
export function agentAuthHeaders(url: string, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (credential && !headers.has("authorization") && isSelectedApiUrl(url)) {
    headers.set("authorization", `Bearer ${credential}`);
  }
  return headers;
}

/** 重置为匿名；测试与开发热重载使用。 */
export function resetAgentCredential(): void {
  credential = null;
}

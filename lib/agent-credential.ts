// Agent Service 凭据：只在内存持有，由可信宿主通道注入。
// Desktop 走 preload，Web 走服务端注入，本地开发走环境变量；不落 Cookie、不进 URL。
// 之所以不用 Cookie：weclio://app 访问 http loopback 属跨站，SameSite=None 要求 Secure，
// 而 loopback HTTP 无法满足，静态入口拿不到 Cookie。

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

/** 在给定请求头上补齐 Authorization；已有值不覆盖。 */
export function agentAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (credential && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${credential}`);
  }
  return headers;
}

/** 重置为匿名；测试与开发热重载使用。 */
export function resetAgentCredential(): void {
  credential = null;
}

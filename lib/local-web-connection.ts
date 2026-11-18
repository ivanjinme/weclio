import { configureApiBase } from "./api-base";
import { setAgentCredential } from "./agent-credential";

/** 生产 Web 从本机 UI 宿主引导；Desktop 与 dev 保留各自的显式配置。 */
export async function connectLocalWeb(signal: AbortSignal): Promise<boolean> {
  if (typeof location === "undefined" || location.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(location.hostname)) return false;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    const response = await fetch("/_weclio/connection", {
      method: "POST", headers: { "X-Weclio-Bootstrap": "1" }, cache: "no-store", redirect: "error", signal: deadline,
    });
    if (!response.ok) return false;
    const { baseUrl, token } = await response.json();
    if (typeof baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) ||
        typeof token !== "string" || !token.trim()) return false;
    deadline.throwIfAborted();
    configureApiBase({ baseUrl });
    setAgentCredential(token);
    return true;
  } catch {
    return false;
  }
}

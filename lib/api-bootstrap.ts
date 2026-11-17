// 本地开发的构建期注入；令牌仅保存在内存。静态入口无注入时保持未配置。
import { configureApiBase, isApiBaseConfigured } from "./api-base";
import { setAgentCredential } from "./agent-credential";

const baseUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WECLIO_API_URL : undefined;
const basePath = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WECLIO_API_BASE_PATH : undefined;
const token = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WECLIO_AGENT_TOKEN : undefined;

if ((baseUrl || basePath) && !isApiBaseConfigured()) {
  configureApiBase({ baseUrl: baseUrl || undefined, basePath: basePath || undefined });
}

if (token && isApiBaseConfigured()) setAgentCredential(token);

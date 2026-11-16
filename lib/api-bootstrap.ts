// 客户端启动时按构建期环境变量指向 Agent Service，并注入内存凭据。
// Next 会把 NEXT_PUBLIC_* 静态内联；Vite 构建没有这些变量，因此保持同源 /api 且匿名。
// 这只是本地开发的注入通道：Desktop 由 preload 注入，Web 由服务端注入。
import { configureApiBase, getApiBase } from "./api-base";
import { setAgentCredential } from "./agent-credential";

const baseUrl = process.env.NEXT_PUBLIC_WECLIO_API_URL;
const basePath = process.env.NEXT_PUBLIC_WECLIO_API_BASE_PATH;
const token = process.env.NEXT_PUBLIC_WECLIO_AGENT_TOKEN;

if ((baseUrl || basePath) && getApiBase().basePath === "/api") {
  configureApiBase({ baseUrl: baseUrl || undefined, basePath: basePath || undefined });
}

if (token) setAgentCredential(token);

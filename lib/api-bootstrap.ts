// 客户端启动时按构建期环境变量指向 Agent Service；未配置则保持同源 /api。
// Next 会把 NEXT_PUBLIC_* 静态内联；Vite 构建没有该变量，因此保持默认。
import { configureApiBase, getApiBase } from "./api-base";

const baseUrl = process.env.NEXT_PUBLIC_WECLIO_API_URL;
const basePath = process.env.NEXT_PUBLIC_WECLIO_API_BASE_PATH;

if ((baseUrl || basePath) && getApiBase().basePath === "/api") {
  configureApiBase({ baseUrl: baseUrl || undefined, basePath: basePath || undefined });
}

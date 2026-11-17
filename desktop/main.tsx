import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { startupSplashMarkup, startupSplashStyles } from "@/lib/startup-splash.mjs";
import { configureApiBase, isApiBaseConfigured } from "@/lib/api-base";
import { setAgentCredential } from "@/lib/agent-credential";
import "../app/styles.css";
import "../app/globals.css";
import "katex/dist/katex.min.css";

// Desktop 静态入口：不经过任何服务端渲染，直接挂载与 Web 共用的 AppShell。
const style = document.createElement("style");
style.textContent = startupSplashStyles;
document.head.appendChild(style);

const splash = document.getElementById("startup-splash");
if (splash) splash.innerHTML = startupSplashMarkup;

/**
 * 宿主（Electron 主进程）下发已选 Service；未配置时保持未选择状态，
 * 由 AppShell 明确提示，而不是隐式回退到任何后端。
 */
async function selectAgentService() {
  const bridge = window.weclioDesktop;
  if (!bridge?.getAgentService || isApiBaseConfigured()) return;
  try {
    const { baseUrl, token } = await bridge.getAgentService();
    configureApiBase({ baseUrl, basePath: "/v1" });
    setAgentCredential(token);
  } catch (error) {
    console.error("[desktop] 无法获取 Agent Service 连接信息", error);
  }
}

void selectAgentService().then(() => {
  const root = document.getElementById("startup-content");
  if (!root) {
    console.error("[desktop] 缺少启动容器 #startup-content");
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <Suspense>
        <I18nProvider>
          <AppShell />
        </I18nProvider>
      </Suspense>
    </StrictMode>,
  );
});

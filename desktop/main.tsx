import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { startupSplashMarkup, startupSplashStyles } from "@/lib/startup-splash.mjs";
import "../app/styles.css";
import "../app/globals.css";
import "katex/dist/katex.min.css";

// Desktop 静态入口：不经过任何服务端渲染，直接挂载与 Web 共用的 AppShell。
const style = document.createElement("style");
style.textContent = startupSplashStyles;
document.head.appendChild(style);

const splash = document.getElementById("startup-splash");
if (splash) splash.innerHTML = startupSplashMarkup;

createRoot(document.getElementById("startup-content")!).render(
  <StrictMode>
    <Suspense>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </Suspense>
  </StrictMode>,
);

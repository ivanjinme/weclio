import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop 静态 UI 构建：输出纯静态资产，由 Electron 用受限自定义协议加载，
// 不需要任何 UI 服务器进程。Web 仍由 Next 构建，两者共用同一套组件。
const root = fileURLToPath(new URL("./", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  piVersion = (JSON.parse(readFileSync(new URL("./node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")) as { version: string }).version;
} catch { /* 未安装 Pi 时保持 unknown */ }

export default defineConfig({
  root: fileURLToPath(new URL("./desktop", import.meta.url)),
  base: "./",
  plugins: [react()],
  // 与 Next 构建保持相同的版本展示；Service 连接信息仍由宿主运行时下发。
  define: {
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(version),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify(piVersion),
  },
  resolve: {
    alias: [
      // 宿主相关实现：静态构建走 history API 与 React.lazy。
      { find: /^@\/lib\/navigation$/, replacement: fileURLToPath(new URL("./lib/navigation.static.ts", import.meta.url)) },
      { find: "@", replacement: root },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL("./build/desktop-ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome130",
    // 静态 Desktop 从本地磁盘加载，没有下载成本；index 包约 2.9MB（gzip 929KB）是当前基线，
    // 包含 React、组件库与 Markdown 渲染依赖。Mermaid/编辑器已按需分包。
    // 真正的降幅需要把消息渲染器改成按需加载（会影响 Web），不能在配置层伪装。
    chunkSizeWarningLimit: 3000,
  },
});

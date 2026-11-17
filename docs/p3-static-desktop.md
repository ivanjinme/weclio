# P3：Desktop 静态 UI 托管

## 结论

Desktop 窗口改为加载 Vite 静态构建（`weclio://app/index.html`），不再启动 `next dev`/`next start`；
业务请求直连独立 Service。开发入口、协议、CSP、凭据交给渲染器的方式与导航信任边界均已落地并有测试。
安装包内的内置 Service、静态资产布局与发行链路仍未完成（P4–P6），当前分支不可发布。

## 实现

- **协议**：`electron/protocol.mjs` 注册 `weclio`（standard/secure/supportFetchAPI），只读静态目录；
  显式拒绝 parent 段、盘符绝对路径、同前缀目录、编码绕过与根外 symlink/junction（读取前 realpath 校验）；
  按扩展名给 MIME，附 `nosniff` 与严格 CSP。
- **CSP 来源收敛**：`connect-src`/`media-src`/`frame-src` 只允许 `'self'`（含 `blob:` 视需要）与**已选定的 Service 源**，
  不再放行任意 loopback 端口；`img-src` 保留 `http:`/`https:` 以维持 Markdown 外链图片，但外链图片仍不带 Service 凭据。
  未下发 Service 源时不授予任何网络访问。Service URL 必须是裸 HTTP(S) 源，拒绝凭据/路径/查询/片段与 CSP 注入。
- **导航信任**：`isAppUrl` 只信任 `weclio://app` 及 `/`、`/index.html` 入口；
  不再信任任何 loopback HTTP 页面（`SERVER_URL`、`restoreDesktopPort`、`desktop-port.json` 一并移除）。
- **连接下发**：主进程从 `WECLIO_DESKTOP_AGENT_URL` / `WECLIO_DESKTOP_AGENT_TOKEN_FILE` / `WECLIO_DESKTOP_UI_DIR`
  读取连接与资产目录，缺任何一项即报错退 1，不启动后备后端；令牌缺失/为空同样失败。
  渲染器通过 preload 暴露的 `agent-service:config` IPC 获取 `{ baseUrl, token }`，仅接受 `weclio://app` 发送方。
  静态资产与 URL 中都不含 Service 地址或令牌；`desktop/main.tsx` 在挂载会发请求的 UI **之前**完成配置。
- **版本展示**：Vite `define` 注入与 Next 相同的 `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_PI_VERSION`，
  不注入任何 Service 连接信息。
- **首帧外观**：原内联主题脚本在 `script-src 'self'` 下被拦，改为 `desktop/public/theme-boot.js` 外置同步脚本。
- **启动器**：`electron/dev-service-ui.mjs` 的 Desktop 分支只预检 Service 端口、要求 `index.html` 存在，
  Service READY + token 校验通过后直接拉起 Electron；不再启动或等待 Next，也不占用 UI 端口。
  Web 分支（`dev:web`）行为不变。
- **更新门禁**：`getGate: () => undefined`，安装器在缺少真实 Service 门禁时拒绝安装（P5 才接真实门禁）。

## 验证

- 全量：961 tests / 951 passed / 10 skipped / 0 failed（`--test-concurrency=4`）。
- ESLint 无警告/错误；源码 TypeScript 167 roots 通过；`git diff --check` 干净。
- 真实独立构建（仓库外 staging 目录）产出 Next UI：`assertUiOnlyBuild` 通过，页面 trace 中 Pi SDK 运行时文件为 0；
  该产物启动后 `/api/sessions`、`/api/agent/running/events`、`/api/models`、`/api/files/test` 均 404，
  浏览器可正常新建会话、流式回复并显示 Blob 图片。
  **这一步修正了旧防护的真实缺陷**：Next 会为静态 `app/favicon.ico` 生成 `/favicon.ico/route`，
  原先的白名单会误判为旧后端；现在只额外允许这一条静态元数据入口，其它 route 依旧拒绝。
- 静态 Desktop（`npm run build:desktop-ui` 真实构建 + Vite）：产物无 Service 地址/令牌；`theme-boot.js` 被复制到产物根，
  内联脚本 CSP 报错消失；版本号已注入。
- 真实 Electron 进程（隔离 HOME/agent/state/workspace、本机 fake model、Service 8896）：
  窗口加载 `weclio://app/index.html`、无 Next 子进程；新建会话、发送、SSE 流式回复成功；
  资源请求全部发往 Service（`/v1/files/...?type=meta|read`），无任何 `/api` 请求；
  页面内直接取同一资源得到 68 字节 PNG 且可解码。

## 已知边界（故意保留）

- **本机自动化窗口不可见**（`document.visibilityState === "hidden"`），Chromium 会无限期推迟 `loading="lazy"` 图片；
  把同一图片改为 `eager` 立即解码（1×1）。这是无头/不可见窗口的渲染行为，不是资源或 CSP 缺陷；
  真实可见窗口下无需处理。
- `electron/production.mjs` 与 `bin/weclio-web.js` 仍是安装版 Next 启动路径，`main.mjs` 已不再调用前者；
  两者在 P4/P6 会分别被内置 Service 与静态资产布局取代。本次不删除，避免半完成的打包改造。
- 打包产物的静态资产布局、CSP 中 Service 源的生产注入、内置 Node/Service、真实更新门禁均未完成。
- `dev:desktop` 每次先构建静态 UI（约 40 秒）；只改组件时可跳过重复构建手动启动。

# Action Plan B — Electron Packaging & Distribution

> **架构方向已确认，业务尚未实施。** 依赖 [Plan A](agent-service-refactoring-plan.md)。本轮仅按确认意见收缩计划，不改 Electron 脚本、生产依赖、签名配置或发布流程，不构建/安装/上传产物。

## 1. 目标产物与核心决策

```text
Weclio
├── Desktop Distribution
│   ├── Electron + Static React UI
│   └── Local Agent Service + Pi SDK + bundled Node/npm + Coding Tools
├── Web Distribution
│   └── React UI（可保留 Next，自有 Web 服务端职责按需保留）
└── Agent Service Distribution
    └── Node Runtime + Service + Pi SDK + 对应平台 Coding Tools
```

- 三类产物分别构建部署，复用必要 Protocol/Client/组件与同一 Service 源码；**不是三个独立业务实现**。
- **已确认：Desktop 使用 Vite 静态 React，Web 保留 Next。** Desktop 不携带/启动 Next Server，不为统一工具链迁移 Web。
- Service 与 Pi 同一 Node 进程，独立于 Electron；**采用捆绑受支持 Node Runtime**，不是要求用户先安装 Node，也不以 Electron utilityProcess/IPC 另造 Agent 协议。
- **硬约束：不得用 Electron 二进制（`ELECTRON_RUN_AS_NODE`）承载 Agent Service。** 独立性优先于包体积：同一份 Service 产物必须能被普通 Node 运行时启动，否则无法部署到 VM，违反「Service 不依赖 Electron」。Desktop 的 Local Service 用随包捆绑的 Runtime 启动；Remote 用镜像/系统 Node 启动，两者是同一产物。
- Desktop/Web/Remote Service 可独立发布；内置 Local Service 初期随 Desktop 完整安装包更新并联合测试，**不新增 Local Service 第二条热更新链**。
- 保留 Builder/NSIS、可靠的签名更新与用户数据语义；静态 UI origin 与 Service endpoint 分离，未来连接 Remote 不等于加载远端网页。
- **本期只落实 Local 分发。** Remote VM/容器为未来架构方向，当前不部署真实环境、不建设 Remote 运维/升级体系；相关验证不阻塞本地主线。
- **新发行面向 `weclio`。** 按已更名仓库和未来新包统一发布字段，正式发布前重新发布新包；不设计旧客户端/旧 feed 过渡。重用验签实现，不维持旧命名约束，也不因此重置用户 Session/配置。

## 2. 当前分发审计与分类

| 分类 | 当前实现 / 证据 | 决策、收益与风险 |
| --- | --- | --- |
| **Replace** | [`production.mjs`](../electron/production.mjs) 查系统 Node/npm、初始化包、启动 `next start`；[`main.mjs`](../electron/main.mjs) 加载 loopback UI | 改 bundled Node→独立 Service、静态 UI；删除 `.next/BUILD_ID` 和 `Ready in` readiness，不再依赖用户 Node |
| **Keep + Refactor** | [`build.mjs`](../electron/build.mjs) 在 `build/desktop/server` 隔离 Next build，但复制开发目录 `npm ls --omit=dev` 的 installed tree | 保留隔离纪律，换独立生产 manifest/锁定安装，不能称现有复制流程已可复现 |
| **Keep** | [`builder.json`](../electron/builder.json)：Windows x64、NSIS、稳定 appId、非管理员安装、ASAR 外服务、卸载不删用户数据 | 不换安装框架；Node 与 Electron native ABI 分别验收，不能只依赖 `npmRebuild:false` |
| **Keep + Refactor** | [`AppShell`](../components/AppShell.tsx) 用 `next/navigation`，[`MarkdownEditor`](../components/MarkdownEditor.tsx) 用 `next/dynamic`，[`layout`](../app/layout.tsx) 用 Next font；UI 网络分散 | 保留成熟组件、编辑器、草稿/消息状态；只改导航/懒加载/字体/Client 和构建入口 |
| **Keep + Refactor** | [`main`](../electron/main.mjs)/[`navigation`](../electron/navigation.mjs)/[`preload`](../electron/preload.cjs)/[`updates`](../electron/updates.mjs) 有 sandbox、导航、permissions、IPC sender 校验，信任当前 HTTP origin | 静态 origin 必须同步更新校验；Remote 地址不能扩展 preload/主窗口信任范围 |
| **Keep + Refactor** | [`toolsets.mjs`](../electron/toolsets.mjs) 的路径/哈希/缓存；[`packages.mjs`](../electron/packages.mjs) 的离线播种、锁、receipt 和不覆盖选择 | 复用机制，扩展 Runtime/tools 清单及缓存复验；播种变成 Service 初始化，Remote 不依赖 Electron |
| **Refactor** | [updater](../electron/updates.mjs) 从 `resources/server/package.json` require 生产依赖 | 依赖属于 Desktop host，必须在删除旧 server 前独立，避免更新功能失效 |
| **Refactor** | [`main.mjs`](../electron/main.mjs) 退出停服务；[`production.mjs`](../electron/production.mjs) Windows `taskkill /T /F`；只有单个本地 URL | 改为明确管理自有 Local 进程及安全关停；退出/后台产品策略到 B3 决定，不默认增加提醒或常驻管理 |
| **Keep + Refactor** | [Ed25519 manifest](../electron/update-signature.mjs)、[EXE SHA512/大小复验](../electron/updates.mjs)、[显式安装/gate/draft veto/失败恢复](../electron/update-install.mjs) | 保留信任链；gate 目前主要覆盖 `rpc-manager`，Skills/Plugins 安装也必须纳入 Service admission |
| **Refactor，方向已定** | [`COMMANDS.md`](../COMMANDS.md) 使用 `ivanjinme/weclio`；源码 [`desktop-update.json`](../resources/desktop-update.json) / [`update-release.mjs`](../electron/update-release.mjs) 仍有 `pi-web` feed/命名来源 | 按用户确认统一为新 weclio 仓库/包；不维护旧 feed 或旧客户端升级通道，保留可信来源与验签 |
| **Defer** | 新安装框架、daemon/后台自动发现、旧客户端过渡、多平台桌面同时重做、Local 热更新器、自动健康回滚、真实 Remote 部署/升级 | 没有当前需求不引入；本地主线 Windows x64，未来 Remote 优先 Linux VM/容器 |

**证据边界：** 当前未捆绑 Node/npm/Git/Bash，资源主要是 rg/fd（[`production`](../electron/production.mjs)、[`builder`](../electron/builder.json)、[runtime](../resources/runtime)）。当前 CI 是 npm 发布/tarball smoke，不是 Windows 安装升级流水线（[workflows](../.github/workflows)）。Ed25519 更新验签不等于 Authenticode，工具哈希不等于数字签名；[合成 updater Range 测试](../electron/updates.integration.test.mjs) 不证明真实 NSIS A→B 或差分升级成功。不以旧交接记录的实验数字承诺新包体/启动收益。

## 3. B1 — Desktop UI 静态化

### PR B1 — 静态 React 入口与宿主适配（静态构建已实施，Electron 接入未做）

- **已完成：**
  - 新增 `desktop/index.html` + `desktop/main.tsx`：静态入口直接挂载与 Web 共用的 `AppShell`，自带启动 splash 与主题/侧栏宽度恢复，无任何服务端渲染。
  - 新增 `vite.config.ts`：`base: "./"`、React 插件、`@` 别名，输出 `build/desktop-ui`（纯静态 HTML+JS，**不含** Pi SDK / Node 内建模块）。
  - 抽出宿主接缝：`lib/navigation.ts`（Next 实现，默认）与 `lib/navigation.static.ts`（history API + popstate），Vite 用别名替换；`lib/dynamic.tsx` 提供 React.lazy 版本，兼容现有「组件或 fallback 组件」返回形态。
  - `components/AppShell.tsx`、`components/MarkdownEditor.tsx` 不再直接 import `next/*`。
  - `npm run build:desktop-ui` 产出约 5.8MB 静态资产；新增 `lib/desktop-static-entry.test.mjs` 守护「入口存在、接缝唯一、产物不含服务端代码」。
- **协议层已实施：** `electron/protocol.mjs` 注册 `weclio://app`（standard/secure/supportFetchAPI）、只读静态目录、显式拒绝 parent 段与根外路径、按扩展名给 MIME、附严格 CSP 与 nosniff；`electron/navigation.mjs` 的 `isAppUrl` 同时信任 `weclio://app` 与过渡期 loopback；Service 的来源白名单可配置（`WECLIO_AGENT_ALLOWED_ORIGINS`，默认仍只允许同源），smoke 已验证 `Origin: weclio://app` 放行、未知来源仍 403。
- **仍未接线：** `main.mjs` 依旧 `loadURL(SERVER_URL)` 走 Next；要把窗口切到 `weclio://app/index.html` 需要一次性完成「协议注册 + 静态目录布局 + Service 白名单下发 + 回归」，否则窗口会加载成功但连不上 Agent。**在切换之前，Desktop 仍启动 `next start`，验收未达成。**
- **依赖：** A3.3 已完成；Vite 依赖已获批并加入 devDependencies（vite 7、@vitejs/plugin-react 5）。

## 3. 执行顺序修订（2026-11，取代原 B1→B2 顺序）

原计划先做静态托管再打包，实测发现真正未验证的是**「客户端 ↔ 独立 Agent Service」这条链路**。改为先用最便宜的方式证明边界，再往上堆宿主与分发：

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| **P1** | 客户端双路由表（`lib/agent/routes.ts`）+ dev 脚本起独立 Service + 浏览器实跑 | 同一 UI 连两种宿主行为一致；SSE 重连/文件/预览/下载/设置可用 |
| **P2** | 退役 Web 进程内 Agent（Next 只留 UI） | Web 内 `import rpc-manager` = 0；`next start` 只提供 UI |
| **P3** | Desktop 接 `weclio://app` 静态托管（dev 允许系统 Node 起 Service） | 窗口加载静态资产，无 `next start` 进程 || **P4** | 捆绑 Runtime（原 B2） | 干净 Windows 无 Node 可跑；VM 用系统 Node 跑同一产物 |
| **P5** | 生命周期与更新门禁（原 B3） | 忙任务不被静默终止；更新失败可恢复 |
| **P6** | 三产物构建 + 原子切换 + 发行（原 B4/B5） | 安装包无 Next Server；真实 A→B 升级不丢数据 |

**当前：P1、P2 已验收完成；P3 静态 Desktop（协议、CSP、连接下发、开发启动器）已实现并实测，P4 未开始。**

- 浏览器已验证侧栏、历史、模型设置；隔离本机模型 fixture 已验证新建、流式聊天、Service 重启后的历史恢复/续聊。
- 测试代理强制断开真实 SSE 后，浏览器自动恢复并携带 `Last-Event-ID`；XHR 上传在隔离工作区真实落盘。
- 修复 Next/Service 的 workspace、pins、titles、models/auth 等路径映射；补齐创建/ensure 与冷启动恢复。
- 默认工作区与既有 Next 行为对齐；开发脚本端口冲突立即失败，只清理自有进程树，使用独立 Next 输出目录。
- 鉴权采用受 origin/path 限制的内存 Bearer。**撤回此前“loopback HTTP 必然无法使用 Cookie”的错误判断。**
- **资源决策已批准并实施：** 共用授权逻辑；2MiB 以下小资源 Blob；PDF、音频、大资源、SVG 与下载走15分钟无状态 Ticket。浏览器已实测预览、播放、Markdown 图片、上传、编辑和原生下载；不使用 Cookie 或 Next 代理。
- P1 验证记录见 [P1 回归](p1-regression.md)；P2 记录见 [Next 退役](p2-next-retirement.md)。已删除39个 Next 业务 handler、旧 instrumentation/proxy/IPC 门禁及 HMR runtime；客户端只连显式选择的 Service，无代理/fallback。
- 开发 Desktop/Web 共用 Service+Next UI 启动器；生产 UI 入口拒绝包含旧后端的编译产物。Next 不再能代表 Agent 返回更新 ready；真实 Service 门禁在 P5 接线，缺失时安装器拒绝安装，不能打包发布当前中间态。
- 真实 provider/OAuth 未用真实凭据测试。P3 还须按选定 Service origin 配置静态 CSP 的 img/media/frame/connect 来源；未执行新的生产构建，也不把浏览器验收当作已打包 Desktop 验收。

**P3 状态：静态托管已接线并实测通过；打包链路（内置 Service/资产布局/发行）仍属 P4–P6。**

- 窗口加载 `weclio://app/index.html`，Desktop 不再启动 next dev/start；Service 连接由宿主进程下发，
  经受限 IPC 交给渲染器内存，不写入静态资产或 URL；缺配置直接退 1，不隐式回退。
- 协议只读静态目录（含 realpath 边界）、严格 CSP；`connect/media/frame` 仅允许已选定 Service 源，
  `img` 保留外链图片但带不上 Service 凭据；导航只信任 `weclio://app` 入口，loopback HTTP 页面不再受信。
- 开发启动器：Desktop 分支只预检 Service 端口，静态资产缺失即失败，Service READY 后直接拉起 Electron。
- 实测：真实独立构建的 Next UI 仅渲染页面且 `/api/*` 全 404；真实 Electron + 隔离 Service 完成新建会话、
  SSE 回复与资源读取。详见 [P3 记录](p3-static-desktop.md)。
- 仍未完成：安装包内置 Service、静态资产布局与商业级更新门禁；`main.mjs` 已不再调用 `production.mjs`。

**纪律：** 不新增运行时开关或 fallback；未完成打包前不得发布桌面安装包。

## 4. B2 — Local Agent Service 打包

### PR B2.1 — 独立生产闭包与 staging 组装

- **模块/修改：** Service build/manifest/lock、host/updater manifest、`package-files`、`packages` 和 `updates` 依赖解析。根锁定方案用最小可维护结构（workspace 或 staging manifests），不为形式创建包平台；保留源码/版本的唯一来源。
- **依赖策略：** 锁定 clean install→Service Node ESM 目录产物；Desktop host/updater 生产依赖独立，不再借 `server`/Service 的包。Pi/dynamic loader 可外置解析，保留运行时需要的 TS/JS、package metadata、templates/themes/export assets、WASM/native/worker；不能只按扩展名或根 devDependency 机械裁剪。
- **初始化：** 消费 A2 已解耦的既有内置包播种/资源初始化，保留已有配置锁、原子发布、receipt 和用户选择；不增加默认 Plugins/Skills，未来独立 Service 同样可调用该初始化。
- **组装：** 独立 Service archive + 临时 Desktop staging 目录可运行；B3 不依赖尚未完成的正式 B4 才能集成。服务执行文件放 ASAR 外，Electron 与独立 Node 的原生依赖分别处理。
- **依赖：** A2.2a–c；与 B1 并行，不依赖 Workspace registry、迁移框架或 Remote 环境，不提前改正式入口。
- **风险/收益：** 明确依赖所有权、减少无关体积；动态 TS 扩展、额外用户依赖、SDK 资源、原生 ABI 易在离开源码树后失败。
- **测试/验收：** 产物移到仓库外、空 HOME、无根 node_modules/NODE_PATH/devDependencies；真实工具循环、TS 扩展（含额外依赖）加载/reload/调用、内置包初始化及 SDK 所需 assets smoke，通过生产闭包运行。仅启动或 ensure_session 不算完整验收；使用 SDK exporter 的测试不等于新增产品 export API。

### PR B2.2 — Bundled Node/npm 与核心工具

- **模块/修改：** Runtime/tools acquisition、manifest/摘要/来源/license、`runtime/toolsets`、PATH 与能力诊断。
- **具体工作：** 选择满足锁定 Pi/依赖的受支持 Node，固定版本/平台/架构/官方来源/摘要与补丁责任；绝对路径启动，不查系统 Node。包含匹配 npm/npx 及 shims，验证 SDK 包管理/Skills 安装的真实布局，不能只复制 `node.exe`。
- **工具政策（已定）：** node/npm/npx 始终使用随包 Runtime 并优先于用户 PATH，清除 Electron/Next 启动污染。**Git/Bash 由用户环境提供，不随安装包分发**；缺失时 shell/Git 能力如实报错，不使用 PowerShell 或精简 Git 冒充等价。rg/fd 仍随包提供。未来 Remote 按对应 OS 提供工具，不把构建 Linux 镜像变成本 PR 前置。
- **分发范围：** 这里的“默认工具”指安装包携带 Node/npm、Git/Bash、rg/fd 等执行环境，不是新装一批 Plugins/Skills。Python/Pandoc/LibreOffice 等办公依赖不扩入本轮默认包；保留原有能力并如实诊断缺失，不新增“所有 Skills 开箱即用”承诺。
- **依赖：** B2.1。具体 Node/tools 版本和体积在本阶段选定，不是 A1 前置决策；Node 捆绑是明确目标（见 §1 硬约束：Service 必须能被纯 Node 启动），Git/Bash 是否随包分发待产品决策，未分发则相应收窄验收措辞，不以 PowerShell fallback 冒充等价。
- **风险/收益：** 无需用户预装 Node，能力更可预测；新增安装体积、安全更新和 NOTICE 责任。工具内容缓存复用也要明确完整性校验策略，不能只扩充文件而沿用仅检查 rg/fd 的假设。
- **测试/验收（已收窄）：** 干净 Windows VM 无 Node/npm/Git/Pi/源码，非管理员、安装目录只读、空格/中文路径，离线首启可完成 Runtime/内置资源准备；模型联网后完成 read/write/edit、rg/fd、npm/npx、动态扩展与子进程测试。**Bash/Git 不作为本包开箱能力**：无 Git 时必须以明确提示降级，不得声称完整 Coding Agent；有 Git 的机器另测 Bash 与 git status/diff。

## 5. B3 — Electron 生命周期与更新交接

### PR B3 — 最小 Local 进程管理与 update gate

- **模块/修改：** `main/preload/navigation/production/server/runtime`、`update-gate/update-install/updates`；Main 只管窗口、安全连接、自有 Local 进程与 Desktop 更新，不导入 Pi/Session 业务。
- **启动/连接：** 捆绑 Node 启动 Service，验证 ready/协议/认证；复用现有单实例约束，端口冲突不接管，不信任仅有 PID/HTTP 200 的陌生进程。当前不做后台服务自动发现、持久 descriptor 或跨 Main 崩溃重附着框架。若 Main 崩溃后不能确认旧 Local 已退出，必须拒绝新建同数据目录 writer，不能靠改端口绕过；具体用最小机制落实于 B3 的生命周期策略。将来接 Remote 只换 Client endpoint，不强制启动 Local，也不改变静态 UI 来源。
- **凭据：** 本地受保护 bootstrap、窄 preload API、必要的凭据存储与日志脱敏；业务认证不自动授予维护/关停权，Desktop 管理能力只由 Main 控制路径持有。不暴露任意 HTTP/FS/进程能力，不为未来 Remote 先建长短 Token 交换平台。
- **退出策略：** 现有 dirty-draft 保护保留。忙任务关窗提醒、默认后台继续与常驻不是本轮已确认功能，**不自动新增**；到 B3 实施时再选明确的 Local 退出策略，并据此测试正常退出/取消/关停。不能把业务 API detach 等同于停止任务，也不能在策略未落实时宣称退出后任务必然继续。
- **更新交接：** 保留原子 inspect/lock/admission、busy 检查、draft veto、超时/断线拒绝安装及失败恢复；覆盖已受管的 startup/队列/compaction/bash/标题/资源安装。只有窗口确认关闭后才关停将被替换的自有 Local，确认退出/文件释放后启动安装器；失败必要时重启原 Service、恢复窗口和准入。保护未通过就不启用新链路安装入口。
- **控制边界：** Main 只管理自己启动的 Local，不停止陌生进程或未来 Remote。已知非自有进程占用安装文件时阻断/延迟，不强杀；不提前建设全机后台进程发现系统。
- **依赖：** B1 + B2.1/B2.2 + A3；使用已有 staging 组装验证，**不依赖 A4 或真实 Remote**。
- **风险/收益：** 去掉 Next supervisor 耦合，保留必要生命周期/更新保护；不借机增加 daemon、后台管理产品或复杂 ownership 平台。

| 场景 | 策略与验收 |
| --- | --- |
| 关闭窗口有 dirty draft | 既有否决/确认不退步，不提前停 Service |
| Local busy/idle 正常退出 | 依 B3 当时确定的退出策略测试；SDK 清理与进程结果明确，不默认新增提醒/后台常驻 |
| Renderer reload/断连 | 不重复提交副作用，不因订阅断开取消 Agent |
| Main / Service 崩溃 | 明确断连/执行结果不明，不自动重发；旧 Service 未确认退出则拒绝重开新 writer；不承诺自动附着或任意子进程完全清理 |
| Desktop 更新 | busy/race/veto/timeout 不能绕过准入，自有进程退出后再替换，安装器失败恢复 |
| 未来 Remote / 非自有 Local | 不由 Desktop 退出/更新流程控制；真实连接切换验收随 A4 延期 |

**测试/验收：** 真实 bundled Runtime/Service 与 staging Electron 验证启动、ready、端口冲突、选定的退出策略、取消、进程异常及 installer 失败；不是只 mock spawn。保留 sandbox/contextIsolation/nodeIntegration=false/webSecurity 与严格导航/permission/IPC sender 校验，不把 Remote 或后台管理作为当前门槛。

## 6. B4 — Build & Release Pipeline

### PR B4.1 — 三类构建与候选产物 CI（先不切换）

- **模块/修改：** scripts/manifest/lock、`build/builder/package-files/release`、`.github/workflows`。分别构建 Desktop 静态 UI/host、Web UI、Service；正式入口暂不切换，CI 显式生成候选产物。
- **布局：** `app.asar` 放 host/updater deps+静态 UI；`resources/agent-service` 放 Service/production deps/SDK assets；`resources/runtime/<platform>` 放 Node/npm/tools；保留更新 trust config。state/Pi 数据/凭据/用户包/workspace 全在用户数据区或持久卷。
- **来源：** clean checkout+锁定生产安装，CI 指定权威 npm 锁路径，清理 npm/bun 双锁职责；记录 commit、协议/Runtime/tools 版本、摘要、生产 closure、许可证/NOTICE。保留隔离 build/fingerprint，但 fingerprint 不是来源签名，不从开发 HOME/.env 取发布资源。
- **依赖：** B1 + B2；可与 B3 并行，生命周期/更新集成测试消费候选产物。保留 Builder/NSIS/appId/用户数据策略；不必兼容旧脚本内部结构。
- **风险/收益：** 提前验证产物而非在切换 PR 才发现缺包；native/WASM、updater 依赖、缓存与跨平台资源须检查。
- **测试/验收：** CI checks→独立 Service Windows smoke→静态 UI/packaged smoke→隔离 Windows NSIS clean install。测试机/测试 VM 用于安装验收，不是部署 Remote Agent；Linux/Remote 运行验收随 A4 再做。生成独立 Service 包与候选 Desktop；生产依赖不借开发 node_modules，不含真实凭据；不自动公开 release。

### PR B4.2 — 正式切换与旧链路退役

- **模块/修改：** 正式 Desktop/Web 入口、旧 Next Agent routes/`instrumentation`/transport、Desktop Next supervisor/build 资源、安装文档及 `COMMANDS.md`。只在 B3 更新安全与 B4.1 产物通过后原子切换，不在前置 PR 提前删仍被生产 Desktop 消费的入口。
- **删除范围：** Desktop Next build/start、`.next` 资源、系统 Node 探测、旧 readiness；旧 Agent API handlers、HMR 生命周期和临时 transport/适配。Web Next 只留 UI/确有必要的 Web 服务端职责，**不保留长期 Agent 兼容代理/fallback**。
- **命名收口：** package metadata、bin/脚本、release/feed/cache 配置、文档和相关测试按新 weclio 包统一；不保留旧 npm 名称/旧 feed fallback。应用数据路径/安装身份不因包更名自动改变，若确需改变再单独处理实际迁移。
- **依赖：** A3.3 + A5 + B3 + B4.1；这是 A 计划后端迁移完成的强制关口，不依赖 A4。
- **风险/收益：** 小而明确的正式切换，不在这里首次发明 build/supervisor；主要风险是漏旧路由/依赖及旧用户数据接管。优先保持数据格式/路径；只有实际改变持久数据时，才增加该变更所需的备份/恢复，不预建迁移系统。
- **测试/验收：** CI 正式生成可安装 Desktop、独立 Web、Service 产物；Desktop 包/进程树无 Next Server/.next/`next start`，无系统 Node 仍完整运行。旧 Session/配置/凭据/包/Workspace 不变，新装/接管/卸载保留均验证；旧 API 不再执行 Agent 业务，Next 纯 UI 仍可用。安装说明只在此更新为已验收能力。

## 7. B5 — Independent Versioning & Updates

### PR B5 — 新 weclio 包发行与更新验证

- **模块/修改：** Client/Service 发布 metadata、`release/update-*`、CI 和发布说明。版本/能力握手、Local 更新保护在前面已完成，不到发布阶段才补安全。
- **版本政策：** Desktop/Web/独立 Service 可独立发版，Protocol 有自己的版本；当前只验证新 Desktop 与内置 Local 的组合。不预建尚不存在的 Remote 历史版本矩阵；真实 Remote 独立发行/升级运维随 A4 再做。
- **Keep / Refactor：** 重用 Ed25519 验签、EXE SHA512/大小复验、stable semver/不降级、后台下载、显式安装、draft veto/失败恢复、NSIS+blockmap/full-download。发布地址和包命名统一到 weclio，保留密码学校验，不为旧 feed/cache 名称增加兼容分支；重命名不要求重建签名机制或无故轮换密钥。
- **首次发行：** 正式发布前重新发布新 weclio 包，测试全新安装；不要求旧 pi-web 客户端自动迁入，也不重置用户原有 Agent 数据。后续更新用两个新 weclio 版本/候选安装包验证 A→B，而不是设计旧客户端跨包升级。
- **更新测试：** 下载中可用、坏签名/hash 拒绝、断流重试、busy/race/draft veto/超时、安装器启动失败恢复、重开与数据完整；记录实际差分/全量传输，不凭 blockmap 存在宣称差分已成功。运行任务不通过更新流程静默强杀。
- **数据：** 默认保持 JSONL、workspace、auth/settings/trust 和用户包；确有不兼容格式/路径变化，才为该变更做一次性迁移、备份/恢复验证。二进制回退不冒充数据恢复，不先建设迁移/自动回滚平台。
- **依赖：** B4.2 + A3/A5；不依赖 Remote 环境、旧客户端或旧 feed。新包具体发布字段随 B4/B5 核对，不是当前额外架构决策。
- **风险/收益：** 新包干净发布、复用成熟更新机制；重点防本地命名/签名来源未收口与更新破坏任务/数据。**验收：** 干净 Windows 新包安装及新包之间真实更新通过；不保证 Remote 升级、Authenticode 或桌面健康自动回滚。

## 8. PR 顺序与放行证据

```text
A3.3 → B1 ────────────────┐
A2 → B2.1 → B2.2 ─────────┼→ B4.1（候选构建/CI）
A3 + B1/B2 ───────────────┴→ B3（Local 生命周期+更新安全）
A5 + B3 + B4.1 → B4.2（正式切换/新包命名/删除旧链路）→ B5
A4 Remote/环境切换延期，不阻塞以上主线
```

B1/B2 提前提供 staging 组装，避免“B3 需要产物、B4 又依赖 B3”的隐性死结；B4.1 和 B3 可并行。每 PR 均有相关测试/typecheck/lint，涉及分发必须跑产物；真实安装/签名/发布另获授权，合并计划或代码不等于获准发布。

| 门禁 | 最低证据 |
| --- | --- |
| 干净安装 | 无 Node/npm/Git/Pi/源码，非管理员/离线准备/中文空格路径/只读安装区；核心工具真实运行 |
| 完整能力 | Chat/Session/树、Files/Git/预览/Range、设置/provider OAuth/资源安装；TS 扩展及额外依赖；每项宣称开箱即用 Skill 实跑 |
| 生命周期 | busy/idle/draft、renderer/main/service 异常、选定的 Local 退出策略、受控启动不重复创建 writer、更新文件占用和失败恢复；不要求后台自动附着或双环境系统 |
| 用户数据连续性 | 现有 JSONL/父链、auth/models/settings/trust/pins、包 receipt/已删除默认包、Workspace 不被重命名或打包重置；UI origin 偏好如需迁移只处理实际差异 |
| 发布证据 | commit、锁定依赖、版本/协议/Runtime/tools 清单、来源摘要/许可证、脱敏安装与进程/更新网络日志；对比实际包体/文件数/启动/总内存 |

本轮不执行这些产品验收，不沿用旧计划/历史实验通过数作为当前证明。

## 9. 已确认与阶段内决策

- **已确认：** Desktop Vite、Web 保留 Next；当前 Remote 仅架构方向；安装包携带核心执行工具，不扩增默认 Plugins/Skills；新仓库/未来包统一 weclio，正式发行前新包重发，不设计旧客户端过渡。
- **到阶段再定：** B2 选具体 Node/npm/Git/Bash 版本、许可与体积；B3 定 Local 退出/后台策略，不先新增忙任务关窗提醒；B4/B5 收口新包发布字段并准备 Windows 安装验收。均不阻塞 A1。
- **保持延期：** 通用锁/迁移框架、持久命令去重、事件 replay、后台常驻管理、全量多环境缓存与 Remote 运维，不因“为未来准备”偷偷进入本地主线。

本轮只修订计划，**没有新的前置架构问题需要用户决定**；A1 业务实施仍等待单独授权。

# Action Plan A — Agent Service 架构演进

> **A 线的主要抽取已实施，但不等于端到端验收完成。当前按 P1→P6 执行：P1 用户已验收通过，P2 Next 退役、P3 静态 Desktop、P4 内置 Runtime/Service 生产闭包均已完成相应隔离验证；
下一步 P5 生命周期与更新门禁，再做 P6 真实安装/升级及发行。VM、Web/Service 单独部署不作为本次 Desktop 发行门槛。A4 延期；B1 静态入口已有基础，尚未切换正式宿主。** Desktop 工作见 [Plan B](desktop-distribution-plan.md)。本文取代旧交接文档中“Desktop Agent IPC / Shared Agent Core”的建议，不改变已有实现事实。

## 1. 目标与架构决策

```text
Desktop（Electron + 静态 React） / Web（React，可保留 Next）
                    ↓ HTTP Commands / ↑ SSE Events
              Agent Service（独立 Node 进程）
                    └─ Pi SDK（同进程）
                       Sessions / Extensions / Tools / Workspace
```

- **一执行环境、一 Agent Service、一份运行数据的写入者。** Local/VM/容器使用相同实现与协议；Service 不依赖 Next、Electron 或客户端连接。
- Pi 负责 Agent Loop、Session JSONL/树和模型上下文；Service 负责运行注册、公开 API、执行准入、授权与生命周期。保留 `AgentSessionWrapper` 的正确行为，不受其现有文件结构约束。
- 只共享必要的 Protocol DTO、Agent Client 和 React 业务代码；Service 内按职责分模块，不另造 Shared Core 服务或包平台。
- 所有执行、文件、Git、目录、模型配置、provider 凭据和资源安装均归目标 Service。Desktop Main 仅承担桌面能力与自有 Local 进程管理。
- 当前一个 Service 对应一个可信所有者；多客户端不等于多用户。未来由外部控制面关联用户与隔离环境，核心不增加 `userId` 多租户分支。
- 未来中心化 Web 可由服务端安全访问私有 Service，沿用本协议；当前不新增 Gateway，不要求浏览器直连私有 VM。SSH 仅作运维/隧道。

**本期主线：独立 Service → 统一 Client → Desktop 静态化与捆绑运行环境。** 当前没有真实 Remote VM/Sandbox，Linux VM/容器仅为未来部署方向；不部署远程基础设施，也不以远程 OAuth/TLS/VM 验收阻塞本地主线。单写入是职责约束，不先建设通用锁框架；尽量不改数据路径/格式，不先建设迁移系统、持久去重账本或事件日志。

## 2. A1 — 仓库审计结论

### 原始审计事实与分类（历史快照，非 P2 后现状）

以下为实施前审计；当前 Next 已不再托管业务后端，见 [P2 记录](p2-next-retirement.md)。

审计覆盖根配置/锁文件、全部 `app/api` 路由组、`lib`、`hooks`、`components`、`electron`、`bin`、CI、相关测试与安装的 Pi SDK 文档/实现；不以缓存、构建产物或历史实验推断现状。当前根依赖锁定 **Pi 1.5.2**；现状是 **Next 进程内运行 Pi**，不是已经独立的 Agent Service（[`package.json`](../package.json)、[`rpc-manager.ts`](../lib/rpc-manager.ts)）。

| 分类 | 证据 / 决策 | 收益与主要风险 |
| --- | --- | --- |
| **Keep** | [`rpc-manager.ts`](../lib/rpc-manager.ts) 的两阶段 services→session 初始化、startup 去重、extension readiness/UI bridge、队列、compaction abort、异步完成通知 | 保护自定义 provider 恢复和成熟交互；不能仅用 `agent_end` 判断全部工作结束 |
| **Keep** | [`session-reader`](../lib/session-reader.ts)/summary/path、[`normalize`](../lib/normalize.ts)、[`streaming-message`](../lib/streaming-message.ts)、[`file-draft`](../lib/file-draft.ts) 的查询/展示/编辑行为；Pi 保持树与持久化权威 | 不重写成熟逻辑；UI 全历史不能误换成压缩后的模型上下文 |
| **Keep** | [`project-trust`](../lib/project-trust.ts) 的 SDK trust gate，[`file-access`](../lib/file-access.ts)/[`path-security`](../lib/path-security.ts)/[`file-write`](../lib/file-write.ts) 的 realpath、链接与写冲突防护 | 保留安全原语；但这些不是 OS sandbox 或多用户 ACL |
| **Refactor** | Next handlers 直接操作 SDK、FS、子进程及缓存；[`sessions/[id]`](../app/api/sessions/[id]/route.ts) 改名/删除、[`projects/rebind`](../app/api/projects/rebind/route.ts)、[`project-trust`](../app/api/project-trust/route.ts) 与 live registry 共享隐式状态 | **迁移写入所有权，而非只搬 prompt**；否则活跃会话被当作离线文件改写 |
| **Refactor** | [`rpc-manager`](../lib/rpc-manager.ts)、[`session-reader`](../lib/session-reader.ts)、[`models-cache`](../lib/models-cache.ts)、[`allowed-roots`](../lib/allowed-roots.ts)、[OAuth callbacks](../app/api/auth/login/[provider]/route.ts) 的 `globalThis`；信号回调只 best-effort shutdown | 改为明确的 Service owner/bootstrap；避免 HMR 全局状态成为部署边界 |
| **Refactor** | [`rpc-manager`](../lib/rpc-manager.ts) 导入 `beginDesktopTask`；[`instrumentation.ts`](../instrumentation.ts) 注册更新 IPC/出站 dispatcher | Service 自有 admission/maintenance；Desktop 更新通过管理接口协调，不反向依赖 updater |
| **Refactor** | [`agent-client.ts`](../lib/agent-client.ts) 仅同源 POST；[UI](../hooks/useAgentSession.ts) 分散 fetch/EventSource/资源 URL；[`commands.ts`](../lib/agent/protocol/commands.ts) 反向依赖 UI 类型 | 收口 endpoint、认证与 DTO；type-only SDK import 是类型耦合，不等于 SDK 已进入浏览器包 |
| **Replace** | Agent 由 Next 启动、[默认 SDK event 透传](../lib/agent-event-wire.ts)、隐含同源和当前 [GET events 冷启动 runtime](../app/api/agent/[id]/events/route.ts) | 独立 Node host、白名单 wire、显式 attach 与纯观察分离；不做长期 Next API 代理 |
| **Refactor → Replace** | [`persistPendingSession()` / fork](../lib/rpc-manager.ts) 自写 JSONL/修改私有 `flushed`、重新 open 可能尚不存在的文件 | 安装 SDK `dist/core/session-manager.js:_hasConversation()` 已在 user/assistant 消息时落盘；先验证首 shell/空分支再消除私有补丁，不丢首轮数据 |
| **Defer** | 真实 Remote 部署、多租户/VM 调度、DB/MQ/Kubernetes、通用跨进程锁、迁移框架、持久命令账本、事件 replay、后台常驻管理、全量多环境缓存改造 | 当前没有独立需求；必要认证、文件授权、Session 所有权和更新保护不随之降级 |

**必须修正的安全认知：** `request-security.ts` 保护 Host/Origin，但允许无 Origin 的非浏览器调用，**不是认证**；cwd validate/new 可扩大内存 roots，不能直接成为远程授权政策。Project Trust 只约束项目资源加载；Tools Off/工具选择也不限制 shell、可信扩展或 OS 权限（[`request-security`](../lib/request-security.ts)、[`cwd/validate`](../app/api/cwd/validate/route.ts)、[`project-trust`](../lib/project-trust.ts)、[`rpc-manager`](../lib/rpc-manager.ts)）。

### API 迁移清单

以下是现存能力，不把 SDK 可用功能或旧设计中的 export/worktree 当作已实现 API：

| 当前路由族（`app/api`） | Service 必须接管 |
| --- | --- |
| `agent/*`、`sessions/*` | new/ensure、commands、单会话/全局 SSE、bash-output；历史/树/state/context/thinking、标题批查/自动命名、改名/删除/父链 |
| `home`、`cwd/*`、`project-trust`、`projects/rebind`、`sidebar-pins` | Service 侧目录、默认 workspace、trust reload、重绑、固定项 |
| `files/[...path]`、`file-index`、`git/*` | list/meta/read/write/watch、上传/冲突检查、download/Range、图片/HTML/DOCX 预览、索引、status/diff |
| `models*`、`auth/*` | 模型发现/配置/测试、provider 列表、API key、OAuth 流和回调；provider 登录不等于 Service 登录 |
| `plugins`、`skills/*`、`usage/codex` | 资源发现/安装/更新、npx/包管理、用量；安装任务同样进入维护门禁 |

## 3. 分阶段 PR

每个实施 PR 独立审查、测试、合并；A4 为延期阶段，不进入本期依赖图。新增入口先用隔离测试数据，不以未完成 Local 生命周期/更新保护的链路替换正式入口。Vite 方向已确认，其他新增依赖遵循仓库审批约束。

### PR A1 — 行为基线与抽离防线

- **模块/修改：** 锁定当前 SDK 与关键 fixture；补 startup 同 ID/失败重试、provider 恢复顺序、trust-before-factory、首 prompt/首 shell/失败落盘、空分支/setup-only fork、shutdown 的真实 SDK 行为测试。其余路由测试随能力迁移进入，不先建庞大 fixture 平台。
- **依赖：** 已完成的架构审计和已确认的实施范围。
- **实施结果（Pi 1.5.2 真实 SDK）：** 新增 `lib/rpc-manager-sdk-startup.test.mjs`（provider 恢复顺序、trust-before-factory、扩展/关停/readiness、Tools Off 及其 reload/延迟注册）与 `lib/rpc-manager-persistence.test.mjs`（首 prompt/shell/失败/abort 落盘、空分支与 setup-only fork、fork 不改源文件）。复现并修复三处缺陷：Tools Off 写只读 `systemPrompt` 且启动空 allow-list 阻止重新启用（改为公开 `getSystemPromptOptions().forceSystemPrompt` + 保留 `refreshTools` 后重应用）；空分支/setup-only fork 返回未落盘、无法恢复的 ID（复用同一 manager 并先落盘）；早期落盘依赖私有 `flushed`（改为公开 `setSessionFile` 并恢复 leaf）。
- **风险/收益：** 私有持久化补丁和无文件 fork 是优先验证点；测试先区分产品必须保留的行为与已有缺陷，不能把缺陷冻结成契约。
- **测试/验收：** 临时 HOME/agentDir/workspace，不读真实凭据；新增用例验证文件/ID/父链和 hooks，不只检查源码字符串。若复现已有缺陷，最小修复随本 PR，超出范围则单列前置 fix PR；不合入持续失败测试、不把错误行为冻结成契约。相关测试绿色、数据风险解决后才迁移。

### PR A3.1 — Protocol 契约与 Client 接缝（已实施）

- **模块/修改：** 新增 `lib/agent/protocol/types.ts`（DTO）、`validate.ts`（运行时校验 + 统一错误）、`version.ts`（protocol major 握手）；`commands.ts` 只依赖 DTO；`agent-client.ts` 重写为可注入 Client；`app/api/agent/[id]` 使用 `parseAgentCommand()` 并返回统一错误 envelope；`lib/types.ts`、`lib/composer.ts`、`lib/tool-presets.ts` 改为转出协议 DTO。
- **冻结命名与政策：** 见 [agent-protocol.md](agent-protocol.md)（envelope、错误码、endpoint、未知字段、版本、客户端注入）。
- **实施结果：** `lib/agent/protocol/validate.test.mjs`（各命令接受/拒绝矩阵、未知字段丢弃、版本协商）与 `lib/agent-client.test.mjs`（注入 endpoint/headers/signal、5 种畸形响应、错误 code/requestId、abort 透传）通过；源码 typecheck 与 lint 通过。
- **未做（按计划）：** 未搬运 handler、未新增 Next 代理、未改鉴权行为、未实现命令去重/replay；这些归 A2.1/A3.2。

### PR A2.1 — 独立 Node Host、Runtime owner 与准入（已实施）

- **模块/修改：**
  - 新增 `lib/agent/admission.ts`：通用准入（reserve/isBusy/tryLock/unlock），不依赖 IPC；`lib/desktop-update-gate.ts` 变为薄适配层，导出 API 不变。
  - `lib/rpc-manager.ts`：`globalThis` 注册表改为 `AgentRuntime` 实例（会话/启动锁/起始目录/运行态订阅/壳探测/准入）；默认实例仍挂 `globalThis` 以兼容 Next 热更新；wrapper 通过注入 hooks 使用所属 runtime，不再直接引用 Desktop 更新模块。
  - 新增 `lib/agent/service/{config,host,entry}.ts`：回环绑定、受保护令牌、`/healthz`、`/v1/info`、`POST /v1/sessions/:id/commands`；单写入者锁、就绪/关闭事件行、信号与 stdin 控制关闭、drain 超时。
- **已落实的约束：** Service 模块图无 Next/Electron/React；业务路由需 Bearer 令牌；非回环地址拒绝启动；同一 `stateDir` 第二进程拒绝启动；客户端订阅断开不影响任务。
- **测试：** `lib/agent/service/service-smoke.test.mjs` 在真实 Node 子进程、隔离 HOME/agentDir/state/workspace 下验证健康/认证/跨源拒绝/错误 envelope/bash 工具执行并落盘/单写入者/优雅退出；`lib/rpc-manager.test.mjs` 改为行为断言（服务先于会话、壳探测缓存、恢复不改工具、同 ID 合并）；gate 测试改用 runtime 公开状态。
- **未做（按计划）：** SSE 与重连（A3.2）、其余路由（A2.2）、编译产物与捆绑 Runtime（B2）、Remote（A4）。入口目前通过 jiti 运行 TS 源码，不代表可分发；模型驱动回路已由 A1 真实 SDK 用例覆盖，Service 侧待 A2.2c 接凭证后补齐。

### A2.2 — 按能力纵向迁移（以下三个独立 PR）

每个 PR 同时交付内部业务、Node API、Client 方法/对应 UI 调用点和测试；旧 handlers 只作临时直接适配，不复制业务、不转发新 API。

| PR | 模块与具体修改 | 依赖 | 风险 / 收益 | 测试与验收 |
| --- | --- | --- | --- | --- |
| **A2.2a Sessions / Commands（已实施）** | 新增 `lib/agent/session-service.ts`（catalog/titles/view/rename/delete/state，runtime 注入）；`app/api/sessions/*` 改为薄适配；Service 增加 sessions/titles/view/state/PATCH/DELETE 路由；rename 走活跃 manager，delete 先 `shutdown` 再删文件并重挂子会话，历史读取不建实例 | A2.1 | 解决活跃文件被第二 writer 改写；私有落盘/fork 修复必须依 A1 实测，优先 SDK 公开能力，缺口先上游/集中 adapter 解决 | 新建/首 shell/首次失败、树导航/fork、延迟 thinking、自动标题、删除父链、并发 mutation；保留 compaction UI 历史及扩展 UI，Service 独立执行完整会话流程。事件流/重连并入 A3.2，避免同一流协议实现两次 |
| **A2.2b-1 Workspace / Trust / Pins（已实施）** | 新增 `lib/agent/workspace-service.ts`（home/default/validate/browse/trust/rebind/pins，runtime 注入）；`cwd/*`、`home`、`project-trust`、`projects/rebind`、`sidebar-pins` 路由改为薄适配；Service 增加 `/v1/home`、`/v1/workspaces/*`、`/v1/projects/*`、`/v1/settings/pins`；trust 先判空闲再写库并释放实例，rebind 沿用准备/回滚，路径仍是 Service 侧政策 | A2.2a | 不留“本机文件、远端操作”的分裂；roots 是 Service 政策 | 未授权路径 403、缺目录 400、运行中 409；rebind 只改指定 cwd 的会话并迁移置顶、更新允许根；操作真实落到 Service 文件系统 |
| **A2.2b-2 Git / File Index（已实施）** | 新增 `lib/agent/git-service.ts` 与 `lib/agent/file-index-service.ts`；`requireAllowedDirectory` 统一“绝对路径 + 词法根 + realpath”校验；git 子进程、diff 祖先授权、索引缓存都留在 Service；`git/*`、`file-index` 路由改为薄适配；Service 增加 `/v1/git/status`、`/v1/git/diff`、`/v1/files/index` | A2.2b-1 | 授权与 git 子进程不得绕过 roots；索引缓存沿用 10s TTL/上限 | 相对/越界/缺失路径分别 400/403/404；tracked/untracked、已删除文件 diff、非 git 目录回退、查询匹配；操作落在 Service 文件系统 |
| **A2.2b-3 Files Service（已实施）** | 新增 `lib/agent/files-service.ts`（授权、list/read/meta/download/preview/watch、写入、Range 解析、响应头与 SVG CSP）；Service 增加 `GET /v1/files/<path>` 与 `PUT /v1/files/<path>`，用 Node 流实现 200/206/416 与 watch SSE；Next files 路由保持原实现（安全原语共用，传输层暂不合并） | A2.2b-2 | 不重写高风险流式路由；Service 侧独立实现传输层，B4 退役 Next 时收敛 | 文本读写、meta、目录列表、Range 206、非法区间 416、watch 首事件与断开清理、非法 type 400；路径越界仍 403 |
| **A2.2b-4 Multipart 上传（已实施）** | Service 新增 `POST /v1/files/<path>?type=upload|upload-check`：用 `Readable.toWeb` 把 Node 请求适配为 Web Request，复用 `parseFormDataWithinLimit` 的字节上限与 `file-upload` 的冲突策略/替换语义；`resolveUploadDirectory` 做词法根 + realpath 双重校验 | A2.2b-3 | 不为适配重写 multipart 解析；上传仍受 25MB/100MB 限制 | 新增/冲突 409（含 conflicts）、skip/overwrite、预检、非法文件名 400、越界目录 403；文件真实落盘 |
| **A2.2c-1 Models / Config（已实施）** | 新增 `lib/agent/settings-service.ts`：模型列表（保留 trust 门控与 enabledModels 过滤）、models.json 读写、默认模型持久化、临时配置连通性测试；`models`、`models-config`、`models-config/default`、`models-config/test` 路由改为薄适配；Service 增加 `/v1/models`、`/v1/settings/models*` | A2.2b-4（已完成） | 模型枚举会执行扩展工厂，必须继续走 trust；配置与凭据仍归 Service 的 agentDir | 未授权 cwd 403、缺目录 400、损坏 models.json 不被静默覆盖、默认模型写入 settings.json、无 key 时测试返回 ok:false 且不联网 |
| **A2.2c-2 Provider 凭据（已实施）** | 新增 `lib/agent/provider-auth-service.ts`：OAuth/API-key provider 列表、凭据状态（不含密钥）、保存/删除密钥、OAuth 登出、provider 模型联网刷新；`auth/{providers,all-providers,api-key,logout}`、`models-config/providers/[provider]`、`usage/codex` 改为薄适配；Service 增加 `/v1/provider-auth/*`、`/v1/settings/models/providers/:p`、`/v1/usage/codex`；新增错误码 `bad_gateway`(502) | A2.2c-1 | 凭据始终留在 Service 的 agentDir；列表/状态接口不得回传密钥 | 状态接口无密钥字段、空 key 400、无 OAuth flow 的登出 400、未知 provider 安全返回；不联网、不使用真实账号 |
| **A2.2c-3 OAuth 与资源（已实施）** | `oauth-login-service` 统一 OAuth 编排（SSE 由宿主转发，挂起 token 按宿主隔离）；`plugins-service` 承担资源包列举与 install/remove/update/disable/enable；`skill-actions-service` 承担 skills 列举、模型调用开关、检查/安装/更新/搜索；`skills-service`/`skill-lock`/`skill-updates` 去掉 `@/` 别名以便 Service 直接加载；Next 路由全部改为薄适配，Service 增加 `/v1/provider-auth/login/:p`、`/v1/plugins`、`/v1/skills*` | A2.2c-2 | 安装/更新是外部子进程，必须占用准入；项目级改动要求授权 + 信任 | 未授权路径 403、未信任项目 403、缺参 400、未知安装 404；install/update 在拒绝路径上不启动子进程 |

**A2 总验收：** 不启动/安装 Next 或 Electron，独立 Service 在仓库外完成上表全部现存能力；同一 SDK 行为基线通过。本阶段用隔离编译目录验证运行能力；独立生产依赖/Runtime 产物验收归 B2，不反向阻断 A2 合并，也不能仅凭源码入口就宣称分发已完成。

### PR A3.2 — 事件流、重连与取消（已实施）

- **模块/修改：** 新增 `lib/agent/session-events.ts`（宿主无关）：先订阅后快照、快照期缓冲、`message_start` 去重、单调 `seq`、`Last-Event-ID` 解析、心跳与 `close()`；Next `app/api/agent/[id]/events` 与 Service `GET /v1/sessions/:id/events` 共用同一实现（原路由自带的快照/缓冲代码删除，避免两套漂移）。
- **语义（已冻结到协议文档 §5）：** 重连不承诺事件回放，带 `Last-Event-ID` 时 `connected.resync=true` 并以快照对账；断连只释放订阅、不取消执行；取消仍走 `abort*` 命令；心跳为 SSE 注释行，`retry` 1s。
- **测试：** `lib/agent/session-events.test.mjs`（9 项：订阅先于快照、快照去重、缓冲顺序、seq 单调、resync、噪声过滤、close 幂等、心跳启停、Last-Event-ID 解析）；Service smoke 覆盖真实 SSE（connected/seq/resync/401）；Next 路由测试改为断言委托与断开清理。
- **未做：** 有界事件 replay 与持久事件日志仍属延期项；OAuth 登录的 SSE 归 A2.2c-3。

### PR A3.3 — 完整 Agent Client（已实施）

- **模块/修改：** 新增 `lib/api-base.ts`（`apiUrl`/`configureApiBase`/`resetApiBase`，默认同源 `/api`）；`createAgentClient()` 未显式传参时跟随该基址；**16 个 UI 文件、66 处**直接写死的 `/api` 调用（fetch、EventSource、图片/下载/预览 URL）全部改走 `apiUrl()`。
- **测试：** `lib/api-base.test.mjs` 覆盖默认同源、远端拼接、绝对 URL 透传与非法前缀；`lib/agent/api-migration.test.mjs` 断言 UI 不再出现写死的 `/api`（清单已清零，新增直接调用会失败）；受影响的组件测试补上 `apiUrl` 沙箱注入，行为断言不变。
- **未做（明确延期）：** 多环境命名空间、切换环境时的草稿/缓存隔离与旧响应失效——这些随 A4 真正启用切换时再做；当前只有单一默认基址。
- **放行条件（B 线）：** Desktop 静态入口与 Remote 连接仍需要真实浏览器回归（聊天/历史/树/文件/预览/下载/设置/OAuth），不能只凭源码断言。

### PR A5 — 身份与持久化归属（已实施）

- **模块/修改：** Service 的 `service.json` 保存持久 `serviceId` 与本次 `instanceId`、协议版本、PID 与 URL；`owner.json` 声明数据目录属主；协议文档新增「身份与数据归属」表（serviceId/instanceId/sessionId/Workspace/凭据/客户端偏好各自归属）。
- **规则：** `serviceId` 重启保留、克隆重生成；`instanceId` 每次启动变化并驱动前端 resync；同一 stateDir 只允许一个存活写入者，残留记录仅在属主进程不存在时接管；`serviceId`/令牌不能替代认证。
- **测试：** `lib/agent/service/service-identity.test.mjs` 真实重启两次，断言 serviceId 稳定、instanceId 变化、identity 文件同步更新；并以存活 PID 模拟占用，断言第二实例拒绝启动（`already owns`）。
- **未做（按计划）：** 不引入持久 Workspace 映射、不批量改写 JSONL、不做迁移框架；仅当确实改变数据路径/格式时才需要一次性迁移。

### A4 — Remote 与环境切换（Defer，不阻塞本地主线）

- **当前边界：** Client 注入 endpoint/认证，Service 不 import Electron/Next，客户端不把自身机器路径当作 Service 路径；本机不同进程即可验证通信解耦。当前不部署 VM/Sandbox，不增加环境管理 UI、远程凭据发放、TLS/反代或 Remote OAuth 工程。
- **未来实现 PR：** 有真实环境后再接 Local/Remote 选择。Linux VM/容器是优先方向，同一 Service 源码和协议；Desktop 选 Remote 不强制启动 Local，所有 FS/Git/Shell 操作落到所选 Service，退出客户端不终止 Remote。
- **到时才做：** 对相关草稿/缓存加 serviceId 隔离、切换前处理未保存内容并使旧异步响应失效；使用两个本机 Service fixture 先测，实际 Remote 可用后再验 VM/容器。
- **安全门槛仍保留：** 真正开放 Remote 前完成认证/加密/授权与 provider OAuth 回调验证，必要时先用安全隧道；roots/Tools Off 不冒充 shell/扩展 sandbox。未来中心化 Web 访问私有 Service 不要求浏览器直连，不提前建 Gateway。
- **依赖/验收：** A3.3 + A5 后、真实 Remote 需求出现时再开 PR；验证 endpoint 切换、两环境不串数据、操作落到正确环境及 Remote 任务独立。此验收不属于当前 Desktop 发布门禁。

## 4. 合并顺序、切换纪律与统一门禁

```text
A1/A2/A3/A5 主要实现完成 → P1 用户验收通过 → P2 Web 去 Agent → P3 静态 Desktop → P4 bundled Runtime/Service 候选完成 → P4 Runtime/Service 打包 → P5 生命周期/更新保护 → P6 发行/升级

P1 未通过前不删除旧 Next 路由；详见 desktop-distribution-plan.md 的 P1→P6 表。

B1 消费 A3.3；B2 消费 A2 的独立入口/能力
B3 消费 B1/B2 + A3，接通 Local 生命周期和更新保护
B4 原子切换正式入口，删除旧 Agent routes/transport/注册
B5 验证新 weclio 包的发行与更新
A4 Remote/环境切换延期，不进入以上依赖链
```

A3.1/A5 的编号表示职责，不代表原始章节顺序；A5 是数据归属收尾，不是新存储系统前置。迁移中旧 Next handlers 仅直接适配同一实现，入口明确选择旧 host 或独立 Service；无 fallback、无双 writer。**B4 退役旧 handlers、HMR facade 与旧 transport 是迁移完成的强制门槛，不允许永久 Next API 兼容代理。** Web 可保留纯 UI/SSR/未来自身认证路由。

每 PR 都须：相关行为测试+本地 typecheck/lint；涉及进程/协议跑真实 HTTP/子进程测试；保留现有 `rpc-manager-*`、session、trust、files、draft 测试的行为断言，替换仅检查源码位置的断言。测试使用隔离数据；构建只在 staging/CI，遵守 [COMMANDS.md](../COMMANDS.md)。本轮未执行产品测试/构建，不沿用旧计划的通过数，也不宣称新架构已经验证。

## 5. 放行风险与已确认边界

| 优先级 | 必须控制的风险 | 放行点 / 收益 |
| --- | --- | --- |
| P0 | 独立入口丢失认证/文件授权、trust 被绕过 | A2 为独立入口补最小认证并保留安全原语；实际 Remote 开放的门槛归延期 A4 |
| P0 | 运行数据被旧/新 host 竞争写、SDK 私有补丁失效 | A1 实测 + A2 单 owner/受控切换；保持数据格式，确有迁移再备份 |
| P1 | 丢响应重复提交、重连缺消息 | A3 不自动重发副作用，复用历史/状态恢复，不宣称跨重启幂等 |
| P1 | 文件/设置等能力漏迁、草稿逻辑被重写 | A2 全量清单 + A3.3 本地跨 origin 回归；切环境隔离随 A4 再做 |
| P1 | 抽离后更新门禁失效 | B3 完成 Local 准入/交接后才 B4 切换 |
| P2 | 未来需求变成当前基础设施负担 | 通用锁/迁移/去重/replay/多环境系统 Defer；只修已验证的迁移阻塞 |

**当前没有额外前置架构决策。** Desktop Vite、Web 保留 Next、Remote 只留方向、新 weclio 包发行已确认。Local 退出策略、具体 Runtime/tools 版本在对应阶段决定，不先新增关窗提醒或后台常驻。本轮只修订计划；下一步 A1 业务实施另等授权。

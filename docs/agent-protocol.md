# Agent Protocol（A3.1 冻结版）

> 本文件冻结当前客户端 ↔ Agent Service 的契约命名与规则。实现仍在 Next 宿主内，接入独立 Service 时只替换 endpoint，不改调用点。

## 1. 归属与依赖规则

| 内容 | 位置 | 规则 |
| --- | --- | --- |
| 线上 DTO | `lib/agent/protocol/types.ts` | 禁止 import SDK/Node/Next/Electron |
| 命令与结果映射 | `lib/agent/protocol/commands.ts` | 只依赖 DTO；命令语义保持不变 |
| 输入校验 | `lib/agent/protocol/validate.ts` | 服务端唯一入口，`parseAgentCommand()` |
| 版本握手 | `lib/agent/protocol/version.ts` | protocol major 与能力协商 |
| 客户端 | `lib/agent-client.ts` | `createAgentClient()` / `sendAgentCommand()` |

UI 侧类型（`lib/types.ts`、`lib/composer.ts`、`lib/tool-presets.ts`）只转出协议 DTO，不再各自定义第二套形状。

## 2. Envelope

```jsonc
{ "success": true, "data": <result> }                       // 2xx
{ "success": false, "error": { "code": "...", "message": "...", "requestId": "..." } }
```

- `data` 必须存在（可为 `null`）；缺失视为 `invalid_response`。
- `requestId` 同时通过响应头 `x-request-id` 返回，便于日志关联。
- 客户端接受旧式 `{ "error": "text" }` 仅作为消息来源，不构成第二套协议。

## 3. 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_command` | 400 | 非对象、未知 `type` |
| `invalid_argument` | 400 | 字段缺失或类型错误 |
| `session_not_found` | 404 | 会话不存在 |
| `command_failed` | 500 | 服务端执行失败（含 SDK 拒绝） |
| `http_error` | 传输层 | 非 2xx 且无可解析错误体 |
| `invalid_response` | 客户端 | 2xx 但 envelope 不合法 |
| `unauthorized` | 401 | 缺少或错误的服务令牌 |
| `forbidden_origin` | 403 | 跨源浏览器请求未获允许 |
| `payload_too_large` | 413 | 请求体超过 1 MiB |
| `not_found` | 404 | 路由不存在 |
| `forbidden` | 403 | 路径未被允许的根覆盖 |
| `conflict` | 409 | 运行中或无需信任等状态冲突 |
| `bad_gateway` | 502 | 上游 provider 刷新失败 |

## 4. Endpoint

P2 起只有独立 Service 提供业务 HTTP/SSE；Next 只提供 UI，不保留 `/api` 业务入口、代理或回退。客户端必须显式选择 Service，默认协议前缀 `/v1`，拒绝旧 `/api` 配置。

```text
GET    /healthz                          活性；无需认证；不返回路径/版本
GET    /v1/info                          需认证；ServiceInfo
POST   /v1/resources/tickets             Bearer 签发资源票据
GET    /v1/resources/content?ticket=...   只读票据兑换；支持 Range
HEAD   /v1/resources/content?ticket=...   完整表示的头，无响应体
POST   /v1/sessions                      创建/ensure 会话；返回真实 sessionId
GET    /v1/sessions                      目录 + 运行中 ID
GET    /v1/sessions/:id                  历史视图（?deferThinking / ?deferMedia）
GET    /v1/sessions/:id/state            运行态（不创建实例）
GET    /v1/sessions/:id/events           会话事件 SSE（id=seq，支持 Last-Event-ID）
PATCH  /v1/sessions/:id                  改名 { name }
DELETE /v1/sessions/:id                  删除并重挂子会话
POST   /v1/sessions/titles               { ids } → 标题
POST   /v1/sessions/:id/commands        恢复已有会话后执行命令；未知 ID 返回 404
GET    /v1/home                          Service 侧用户目录
GET    /v1/workspaces/default            Service 默认工作区
POST   /v1/workspaces/default            创建并授权默认工作区
POST   /v1/workspaces/validate           { cwd } → 规范化并授权
GET    /v1/workspaces/browse?path=       目录浏览
GET    /v1/projects/trust?cwd=           信任状态
POST   /v1/projects/trust                { cwd } → 信任并释放受限实例
POST   /v1/projects/rebind               { oldRoot, newRoot } → 迁移会话路径
GET    /v1/provider-auth/oauth           OAuth 类 provider 及登录态
GET    /v1/provider-auth/providers       API key 类 provider
GET    /v1/provider-auth/api-key/:p      凭据状态（不含密钥）
POST   /v1/provider-auth/api-key/:p      { apiKey } → 保存
DELETE /v1/provider-auth/api-key/:p      删除已存密钥
POST   /v1/provider-auth/logout/:p       登出 OAuth provider
GET    /v1/provider-auth/login/:p        OAuth 登录 SSE（auth/device_code/select/prompt/progress/success|cancelled|error）
POST   /v1/provider-auth/login/:p        { token, code } → 回填授权码或跳转 URL
GET    /v1/settings/models/providers/:p  联网刷新 provider 模型
GET    /v1/plugins?cwd=&global=          资源包列表（项目级受 trust 门控）
POST   /v1/plugins                       { action: install|remove|update|disable|enable, source, scope, cwd }
GET    /v1/skills?cwd=&global=           skill 列表
PATCH  /v1/skills                        { filePath, disableModelInvocation }
POST   /v1/skills/check                  { cwd, package, scope } → 可用更新
POST   /v1/skills/install                { package, scope, cwd } → npx 安装（占准入）
POST   /v1/skills/update                 { cwd, package, scope } → 更新（占准入）
POST   /v1/skills/search                 { query, limit } → 远端搜索
GET    /v1/usage/codex                   Codex 用量
GET    /v1/models?cwd=                   模型列表（受项目信任门控）
GET    /v1/settings/models               models.json 读取
PUT    /v1/settings/models               models.json 写入
PUT    /v1/settings/models/default       { provider, modelId } → 全局默认模型
POST   /v1/settings/models/test          模型连通性测试（临时配置，不落盘）
GET    /v1/git/status?cwd=               Git 状态
GET    /v1/git/diff?cwd=&path=           Git 文件 diff
GET    /v1/files/<path>?type=            list / read / download / meta / preview / watch（read 二进制与 download 支持 Range）
PUT    /v1/files/<path>                  覆盖写入已存在的文本文件
POST   /v1/files/<path>?type=upload      multipart 上传（?conflict=error|overwrite|skip）
POST   /v1/files/<path>?type=upload-check { fileNames } → 冲突预检
GET    /v1/files/index?cwd=&q=           文件索引（无 q 返回列表，有 q 返回匹配）
GET    /v1/settings/pins                 置顶列表
PATCH  /v1/settings/pins                 { type, id, pinned }
```

- 除只读 Ticket 兑换外，业务路由（`/v1/*`）要求 `Authorization: Bearer <token>`；令牌来自受保护文件（默认 `stateDir/service-token`，`0600`，或 `WECLIO_AGENT_TOKEN_FILE`）。
- 仅绑定回环地址；非回环在 A2.1 直接拒绝启动。
- 同一 `stateDir` 只允许一个写入者；属主进程存活时第二个实例拒绝启动。
- 会话查询与 mutation 已就位；files / git / settings 随 A2.2b–c 补齐；事件流与重连统一在 A3.2 实现。

### 4.1 客户端实际使用的端点

| 用途 | Service |
| --- | --- |
| 命令 | `POST /v1/sessions/:id/commands` |
| 会话事件 | `GET /v1/sessions/:id/events` |
| 运行态全局流 | `GET /v1/events` |
| 会话状态 | `GET /v1/sessions/:id/state` |
| 上下文 | `GET /v1/sessions/:id/context` |
| 延迟思考块 | `GET /v1/sessions/:id/entries/:entryId/thinking` |
| 自动命名 | `POST /v1/sessions/:id/auto-name` |
| bash 输出 | `GET /v1/sessions/:id/bash-output` |

`lib/agent/routes.ts` 仅生成 Service 路由。少量历史 UI 后缀仍在客户端转换，不是服务端别名。
未配置 Service 时 AppShell 显示连接配置提示，不挂载会发业务请求的界面；凭据本身不能隐式选择后端。

### 4.2 跨源与凭据

- Service 对 `WECLIO_AGENT_ALLOWED_ORIGINS` 中的源应答 CORS 预检（`OPTIONS` 204），
  允许 `authorization`、`content-type`、`last-event-id` 请求头。
- 当前浏览器请求采用内存 Bearer：`lib/agent-credential.ts` 持有令牌，
  `apiFetch` / `createEventStream` 仅为已选 Service 的 origin + API 路径附加；XHR 上传同样附加。
- **更正：** 撤回此前“loopback HTTP 必然不能用 Secure Cookie”的未经充分验证的判断。
  当前保留 Bearer；原生资源采用下面的 Blob/Ticket 通道，不继续更改 Cookie 架构。
- SSE 由 `lib/event-stream.ts` 以 fetch 流读取，自动重试网络错误/EOF/5xx，
  保留 `Last-Event-ID`，401/403 等终止性错误不重试；服务端据游标置 `connected.resync`。
  关闭订阅取消 reader/重试 timer，但不取消 Agent 任务。

### 4.3 资源访问

共享 SDK `acquireResource({ filePath, kind, sessionId?, revision?, source? }, { native?, signal? })`
返回 `{ url, transport: "blob"|"ticket", expiresAt?, release() }`。小资源以 Bearer
读取并生成 Blob URL（严格 2MiB 传输上限，切换/卸载释放）；PDF、音频、SVG、大资源和下载使用 Ticket。
DOCX Blob 预览必须保留 iframe sandbox，SVG 使用原生 URL 保留服务端 CSP。

签发请求：`POST /v1/resources/tickets`，JSON `{ filePath, kind: "read"|"preview"|"download", sessionId?, source?: "bash-output" }`。
需要正常 Bearer 和来源检查；返回 `{ ticket, expiresAt }`，expiresAt 为 epoch milliseconds。
普通资源共用 `resolveFileTarget` 的根/realpath/会话引用授权；Bash 输出仅允许 download + sessionId，
继续使用 spill 路径、真实 bashExecution 引用和 no-follow 句柄授权。

兑换仅允许 `GET|HEAD /v1/resources/content?ticket=...`，不附 Bearer；只接受一个 ticket 参数，
其他路径、方法、用途不可复用。签名绑定实例、规范化真实资源路径、用途、会话/source 和 15分钟有效期；
每个宿主内存随机 HMAC 密钥，重启失效，无票据记录或逐票撤销表。兑换必须重新授权；沿用既有根缓存，
不承诺瞬时撤销或不可变文件快照，也不引入多用户权限模型。

GET 支持单段 Range 206/416；HEAD 忽略 Range，返回完整表示的头且不返回字节。
资源响应/错误采用 no-store、no-referrer、nosniff；预览保持受限 CSP，允许显式受信任 UI 作为 frame ancestor。
长期 Bearer 不进入 URL；Ticket URL 本身仍是敏感能力，部署者须对代理访问日志屏蔽该查询参数。
SDK 不把 URL/底层传输错误原文暴露到异常。下载每次点击重新签发；过期/重启后需重新取得资源 URL，
预览工具栏或媒体错误态可刷新，不通过定时更换 src 打断当前视图。

## 5. 会话事件流

`GET /v1/sessions/:id/events` 由 Service 中的 `lib/agent/session-events` 实现：

1. **先订阅，再读快照**；快照发布期间到达的事件先缓冲，之后按序补发。
2. 首事件为 `connected`，携带 `sessionId`、`isStreaming`、`resync` 与 `seq`。
3. 若会话正在流式输出，紧接一条 `message_start` 携带当前 partial；快照已包含的 `message_start`/`message_update` 不重复发送。
4. 每个事件带单调递增 `seq`，同时作为 SSE `id`。
5. **重连不承诺事件回放**：带 `Last-Event-ID` 时 `connected.resync = true`，客户端应以快照重新对账（历史消息另走会话查询）。
6. 断连只释放订阅，**不取消** Agent 执行；取消必须显式发送 `abort`/`abort_bash`/`abort_compaction`。
7. 心跳为 SSE 注释行（默认 30s）；`retry` 建议 1s。

## 6. 未知字段政策

- 输入：未知字段不报错，但**不保证透传**；`parseAgentCommand()` 只输出已定义字段。
- 输出：事件与结果必须白名单投影；新增字段需同时更新本文件、校验函数与测试。

## 7. 版本与能力

- `PROTOCOL_VERSION`（当前 `1`）表示 major；应用版本、Pi 版本只是实现元数据。
- `ServiceInfo.protocol = { version, minClient }`；`negotiateProtocol()` 要求 major 相等且 `minClient <= clientProtocol`。
- 协商失败必须在副作用前拒绝，不能靠版本字符串相等判断兼容。

## 8. 客户端约定

`createAgentClient({ baseUrl, basePath, headers, fetch, signal })`：

- `baseUrl` 留空表示同源；Remote 时填 Service 源。
- 认证走 `headers()` 每次解析，长期凭据不得进入 URL 或日志。
- 支持 `AbortSignal`；中止错误原样抛出，不包装成协议错误。
- 网络失败转为 `http_error`，保留 `cause`。
- 组件不得直接 `fetch(apiUrl(...))` 或 `new EventSource(...)`：分别走 `apiFetch` 与
  `createEventStream`，否则连到 Service 时会缺令牌。`lib/agent/api-migration.test.mjs` 会拦住回退。

## 9. 身份与数据归属

| 标识 / 数据 | 归属与规则 |
| --- | --- |
| `serviceId` | Service 持久身份，写入 `stateDir/service.json`，**重启保留**；克隆/新环境必须重新生成 |
| `instanceId` | 每次启动生成，用于识别重启与触发前端 resync |
| `sessionId` / entryId | 沿用 Pi；跨 Service 用 `serviceId + sessionId` 定位，不改 JSONL/树/父链 |
| Workspace | 由 `WECLIO_AGENT_WORKSPACE` 指定，归该 Service；当前不引入持久 workspaceId 映射 |
| Pi 数据 / 凭据 / trust / pins | 归 Service 的 `agentDir`（`PI_CODING_AGENT_DIR`） |
| 客户端偏好 | 归客户端；长期凭据不入 URL/日志 |

- 同一 `stateDir` 只能有一个存活写入者：`owner.json` 记录的 PID 存活时，第二个实例拒绝启动；残留记录在属主进程不存在时才被接管。
- `serviceId`/令牌**不是**认证替代品：令牌仍由受保护文件提供。

## 10. 尚未包含

Provider OAuth 登录由 `lib/agent/oauth-login-service` 编排，Next 路由与 Service 共用同一实现；登录状态（挂起的手动输入 token）按宿主实例隔离，不跨实例共享。

认证授权细化与重新连接（A3.2）、命令去重与回执、事件 replay、文件/设置路由、Remote 部署。Service 入口目前通过 jiti 直接运行 TS 源码，编译产物与捆绑 Runtime 归 B2。

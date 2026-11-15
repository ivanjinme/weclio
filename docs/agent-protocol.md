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

## 4. Endpoint

当前（临时 transport，直连宿主）：

```text
POST /api/agent/:sessionId        → AgentCommand → AgentCommandResult
GET  /api/agent/:sessionId        → { running, state? }
GET  /api/agent/:sessionId/events → SSE
```

独立 Service（A2.1 已提供最小集）：

```text
GET    /healthz                          活性；无需认证；不返回路径/版本
GET    /v1/info                          需认证；ServiceInfo
GET    /v1/sessions                      目录 + 运行中 ID
GET    /v1/sessions/:id                  历史视图（?deferThinking / ?deferMedia）
GET    /v1/sessions/:id/state            运行态（不创建实例）
PATCH  /v1/sessions/:id                  改名 { name }
DELETE /v1/sessions/:id                  删除并重挂子会话
POST   /v1/sessions/titles               { ids } → 标题
POST   /v1/sessions/:id/commands?cwd=…   按需启动会话并执行命令
GET    /v1/home                          Service 侧用户目录
GET    /v1/workspaces/default            Service 默认工作区
POST   /v1/workspaces/default            创建并授权默认工作区
POST   /v1/workspaces/validate           { cwd } → 规范化并授权
GET    /v1/workspaces/browse?path=       目录浏览
GET    /v1/projects/trust?cwd=           信任状态
POST   /v1/projects/trust                { cwd } → 信任并释放受限实例
POST   /v1/projects/rebind               { oldRoot, newRoot } → 迁移会话路径
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

- 业务路由（`/v1/*`）要求 `Authorization: Bearer <token>`；令牌来自受保护文件（默认 `stateDir/service-token`，`0600`，或 `WECLIO_AGENT_TOKEN_FILE`）。
- 仅绑定回环地址；非回环在 A2.1 直接拒绝启动。
- 同一 `stateDir` 只允许一个写入者；属主进程存活时第二个实例拒绝启动。
- 会话查询与 mutation 已就位；files / git / settings 随 A2.2b–c 补齐；事件流与重连统一在 A3.2 实现。

客户端通过 `basePath` 切换（`/api` → `/v1`），不改调用点。

## 5. 未知字段政策

- 输入：未知字段不报错，但**不保证透传**；`parseAgentCommand()` 只输出已定义字段。
- 输出：事件与结果必须白名单投影；新增字段需同时更新本文件、校验函数与测试。

## 6. 版本与能力

- `PROTOCOL_VERSION`（当前 `1`）表示 major；应用版本、Pi 版本只是实现元数据。
- `ServiceInfo.protocol = { version, minClient }`；`negotiateProtocol()` 要求 major 相等且 `minClient <= clientProtocol`。
- 协商失败必须在副作用前拒绝，不能靠版本字符串相等判断兼容。

## 7. 客户端约定

`createAgentClient({ baseUrl, basePath, headers, fetch, signal })`：

- `baseUrl` 留空表示同源；Remote 时填 Service 源。
- 认证走 `headers()` 每次解析，长期凭据不得进入 URL 或日志。
- 支持 `AbortSignal`；中止错误原样抛出，不包装成协议错误。
- 网络失败转为 `http_error`，保留 `cause`。

## 8. 尚未包含

认证授权细化与重新连接（A3.2）、命令去重与回执、事件 replay、文件/设置路由、Remote 部署。Service 入口目前通过 jiti 直接运行 TS 源码，编译产物与捆绑 Runtime 归 B2。

# P1 联调回归记录

## 当前结论

**P1 已由用户明确验收通过（2026-11-17）。** 本文保留 P1 当时的验证快照；后续 P2 已退役 Next 业务后端，不再支持这里历史对照的双宿主模式。当前进展见 [P2 记录](p2-next-retirement.md)。

## 已修复

- 开发脚本仅等 token、不等 READY，以及 UI 端口占用后遗留 Service。现在预检查端口、等就绪、失败关闭自有进程树；不终止其他 Node，不删除用户 Next 产物。
- Service UI 使用独立 Next dev 输出目录，避免沿用普通 UI 的 NEXT_PUBLIC 引导产物。
- UI 不同于 Service 的路径：workspace、pins、POST title 批查、models/auth、运行态、bash-output 等统一由客户端路由转换；Next 保留历史路径，无服务端兼容代理。
- 新建/ensure 会话缺少 Service 入口；两种宿主共用创建逻辑，保留模型/思考/工具选择、真实 ID、首次持久化行为。
- 冷启动命令/事件用旧 ID 创建空会话：现在恢复原文件及 cwd，未知会话 404。
- context、模型与文件 metadata 请求遗漏鉴权；XHR multipart 上传补 Bearer，不破坏进度。
- fetch SSE 替换后失去 EventSource 自动重连：恢复网络/EOF/5xx 重试及 Last-Event-ID，401/403 终止，关闭清理 reader/timer。
- 自动 Bearer 原先可能发给任意绝对 URL：限定到已选 Service origin + API 路径，不向外站或另一个 Client 环境隐式提供凭据。
- 默认 workspace 与既有 Tasks 分类对齐。显式 workspace 覆盖仍属于部署者选择。

## 浏览器证据

使用 agent-browser 独立 session；未停止用户 8888 进程。

1. 真实数据只读回归：侧栏 pins/catalog/titles、历史 view/state、目录 list、Git status、trust、模型配置与 provider 列表均返回 200，确认请求发向独立 Service `/v1`，不是旧 `/api`。
2. 后续写操作使用隔离 HOME/agentDir/state/workspace，本机 OpenAI-compatible fixture 返回 `P1_LOCAL_FIXTURE_OK`，不使用用户模型凭据。
3. 浏览器新建、发送并收到流式回复；标题出现在 Tasks。重启测试 Service 后恢复同一历史并成功续聊，原会话没有变为空白。
4. 测试代理强制断开真实 SSE：浏览器自动恢复，会话事件重连回传 `Last-Event-ID: 12`。单元测试另覆盖 CR/LF 分块、游标清空、终止性错误和关闭竞态。
5. 通过浏览器的文件 input 走真实 XHR multipart 上传，隔离 workspace 中读回内容与 fixture 一致。
6. 先复现 SVG 的原生资源鉴权失败，再验证修复：PNG（含聊天、编辑器、只读 Markdown）走 Blob 正常解码；SVG 走 Ticket 正常解码，保留服务端安全头。
7. 音频通过 Ticket 取得元数据并实际播放；PDF 原生查看器显示 fixture；小 DOCX 走 sandbox Blob 预览、大 DOCX 走 Ticket 预览；3MiB 图片走 Ticket，未整份预取为 Blob。
8. 文件编辑写入隔离工作区成功；新的 XHR 上传文件逐字节匹配。Chrome 原生附件下载完成（16 bytes），落盘文件与源文件一致。agent-browser 的 download 命令也取消纯 Blob 探针下载，因此改用 CDP 配置 Chrome 下载行为后触发同一个 UI 按钮，不修改产品下载逻辑。

本机产物（不进版本库）：`build/regression/resources-chat.png`、`resources-pdf.png`、`resources-docx.png`、`resources-docx-native.png`、`downloads/regression.txt`、`isolated/stream-connections.json`（均位于 `build/regression/`）、测试日志。

## 自动验证

- 全量：949 tests / 939 passed / 10 skipped / 0 failed（test-concurrency=4）。
- ESLint 干净；源码 TypeScript 211 roots，生成的 `.next`/`build` 不作为源码门槛。完整 tsc 仍受旧 `.next/types/validator.ts` 引用已不存在 export route 影响。
- 资源测试覆盖签名篡改/过期/实例隔离、严格 scope/query、Bearer 签发、根与会话引用撤回、目录链接替换、Range/HEAD、Bash 专用权限、Blob 上限与取消/释放竞态。Windows 普通 symlink 子场景缺权限时仅诊断；junction 替换独立测试实际执行通过。
- 上轮会话/SSE 修改曾独立只读审查无发现；本轮资源代码已自查，但独立审查未完成，不能沿用上轮结论。

## 已批准并实施的资源决策

保留 Bearer；共用现有资源授权检查。小资源采用有字节上限和显式释放的 Blob；需要原生 URL 的资源采用无状态 Ticket。无 Cookie、新依赖、票据数据库、永久 Next 代理或多用户平台。

- SDK：`lib/resource-client.ts`、`hooks/useResourceUrl.ts`；2MiB Blob 上限，超限退回 Ticket。SVG 使用 Ticket，避免 Blob 丢失原响应安全头。
- Ticket：Bearer POST 签发，签名绑定资源/用途/会话/source/实例/15分钟有效期；GET/HEAD 兑换重新授权，根/会话引用缓存沿用既有策略，不承诺即时撤销。
- 文件树、文件预览、Markdown、编辑器、Bash 完整输出的下载/图片均接入共享通道；外部图片不附 Service 凭据。
- Bash 输出保留特定 spill 路径、会话真实引用、no-follow 文件句柄检查；不是普通路径授权的宽松替代。
- 下载每次点击重新签发。预览/播放的后续请求若在到期或 Service 重启后失败，需要刷新资源；文档工具栏和媒体错误态提供刷新。不用定时换 URL 强制打断阅读/播放。
- 票据允许有效期内多次 Range，不是一次性票据；绑定实时文件路径而非不可变内容快照。响应 no-store/no-referrer，URL 仍是敏感能力，未来反向代理必须屏蔽该查询参数的访问日志。

此前“loopback HTTP 必然不能使用 Secure Cookie”的表述已撤回；当前不继续改 Cookie 架构。

## 后续阶段

P1 用户验收已完成；真实 provider/OAuth 不在本轮隔离 fixture 验证范围，未触碰真实凭据。Desktop 静态宿主 CSP/接线留在 P3，打包、安装/升级留在后续阶段；不把浏览器结果当作已打包 Desktop 验收。

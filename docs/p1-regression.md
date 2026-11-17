# P1 联调回归记录

## 当前结论

P1 尚未完成；API、会话与 SSE 已验证，原生媒体/下载认证待决策。P2（删除旧 Next Agent 后端）未开始。代码抽取、HTTP smoke、浏览器验收是三个不同门槛。

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
6. 点击 SVG 预览明确复现原生资源鉴权阻塞（Failed to load image），未绕过授权、未把长期令牌放入 URL。

本机产物（不进版本库）：`build/regression/chat.png`、`build/regression/upload-and-media-blocker.png`、`build/regression/isolated/stream-connections.json`、测试日志。

## 自动验证

- 全量：908 tests / 898 passed / 10 skipped / 0 failed（test-concurrency=4）。
- ESLint 干净；源码 TypeScript 206 roots，生成的 `.next`/`build` 不作为源码门槛。完整 tsc 仍受旧 `.next/types/validator.ts` 引用已不存在 export route 影响。
- 独立只读审查：无本轮新增缺陷发现。

## 待用户决策

原生 `img/audio/iframe`、浏览器下载不会使用 apiFetch 的 Authorization。需要选择：

- fetch Blob：保留当前认证方式，但整文件先取到浏览器，不能当作原生大文件/Range 流的等价替换。
- Service 签发资源级短时票据：保留流式/Range；需要批准 URL 中携带受限能力，以及 TTL/日志/引用策略。
- 调整浏览器认证或同源通道：重新评估 Cookie/宿主媒体通道；属于架构变更，不能偷偷加入永久 Next 代理。

此前“loopback HTTP 必然不能使用 Secure Cookie”的表述未经充分验证，已撤回；不能用它排除所有 Cookie 方案。

## 尚未验收

原生媒体/下载；真实 provider/OAuth；完整富文本与文件编辑交互；打包后的 Desktop；安装/升级。P1 通过后才推进 P2。

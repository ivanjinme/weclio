# 标准 Node.js 收敛执行计划

状态：实施中（E1–E3 代码完成，E4 分发验收与 E5 真安装待做）。生产 Web 默认启动链已接通，Windows 隔离生产构建已验证实际页面、认证 HTTP 和 SSE；候选 tarball 已生成，干净环境 npm 安装待验收。Desktop 已改用系统 Node；Windows 的真实 ASAR 解包候选已核对实际子进程路径、主窗口渲染和正常退出，产物不含 Node/npm Runtime。更新交接在关闭窗口后锁定并等待 Service 正常退出；交接和失败重试通过测试，尚未实跑 NSIS 升级。Profile 单写者（OS 互斥端点，先于包初始化）、显式 attach、业务写入统一准入均已实现，
并有真实共存回归：Desktop(ASAR)+系统 Node 拥有 Service，Web attach 完成 bootstrap/CORS/会话/SSE，
未列出的回环源仍 403，关闭 Web 不影响 Desktop，第二个 managed Service 被拒绝且不创建状态目录。

## 1. 目标与边界

目标不是保证“第一次提交零缺陷”，而是在实施前确定边界，把分发、并发、安全和失败路径纳入同一交付门禁，避免先做一条 happy path、随后再补一轮架构。

必须成立：

1. Agent Service 的同一套业务代码以标准 Node.js 为基准；运行和独立部署不需要 Electron、Next 或源码仓库。
2. Web 与 Desktop 只通过 HTTP + SSE 使用业务能力。宿主管进程不等于 Service 依赖宿主。
3. Desktop 使用用户安装的系统标准 Node.js；不捆绑、不自动下载 Runtime，不设置其他 Runtime 后备分支。
4. `npx @weclio/web` 默认启动完整的本地 Web 应用，而不是一张没有后台的页面。
5. 生产版本必须验证真实 tarball / Desktop 资源布局，不以源码开发成功替代。

明确不做：重写 Pi 会话/上下文/持久化语义、切换 Web UI 框架、恢复 Next 业务后端或业务代理、新建多租户/VM 管理平台、引入通用任务系统/凭据数据库、另开长期技术债阶段。

本次第一批认证目标：Desktop Windows x64；Web/独立 Service Windows x64 与 Linux x64。macOS、ARM、musl 不因“代码是 JS”而被宣称已支持。远程基础设施不是本次交付阻塞项；Linux 上无 UI、无 Electron 的独立启动是必要门禁。

## 2. 复核发现：必须纠正的遗漏

| 编号 | 问题及依据 | 对计划的影响 |
| --- | --- | --- |
| G1 | `bin/weclio-web.js` 只 spawn Next；`package.json.files` 没有 Service。 | 默认生产命令必须同时解决启动和分发。 |
| G2 | `lib/api-bootstrap.ts` 读取 `NEXT_PUBLIC_*`，开发启动器在编译时注入地址/Token。 | 不能只补一个子进程；要补先于 UI 挂载的运行时连接引导。 |
| G3 | npm 随附的 `package-json.md` 与 `npm-packlist/lib/index.js` 明确把普通 `node_modules` 排除，打包依赖另走 `bundleDependencies`。 | 不能用 `files: ["service/**"]` 假定完整依赖已进包；必须检查真实 tarball。 |
| G4 | 当前单一 bin 为 `weclio-web`；npm 的 `libnpmexec/lib/get-bin-from-manifest.js` 在多个不同 bin 且没有匹配非 scope 包名的 bin 时会拒绝自动选择。 | 不直接再加一个不同的 `weclio-agent` bin，否则可能破坏 `npx @weclio/web`。用现有单一 bin 的子命令。 |
| G5 | `electron/local-service.mjs` 强制包内 Node；`runtime.mjs` 把该目录放到 PATH 首位。 | 替换的不只是 executable，还包括 npm/npx、子工具 PATH、构建输入、发布测试和安装前提。 |
| G6 | `claimOwner()` 是读、检查、再写，不是原子占有；且只按 stateDir 判定。Desktop 与 Web 可有不同 stateDir 却共用同一 Pi agentDir。见 `lib/agent/service/entry.ts`、`electron/main.mjs`。 | 先确定 profile 单写者规则；启动互斥必须原子化，且早于内置包初始化。 |
| G7 | 生成入口在 `main()` 前运行内置包初始化；初始化依赖固定 `root/node_modules` 布局和既有 receipt。见 `electron/service-build.mjs`、`electron/packages.mjs`。 | 中立化不能只改目录名；要支持 npm/Desktop 的实际模块布局，并保持用户数据及 receipt 兼容。 |
| G8 | `/v1/plugins` 直接调用 `mutatePlugins()`，未像 skills 安装那样取得 Runtime reservation；文件、设置、认证等写入也不能仅凭 SDK busy 判定覆盖。见 `lib/agent/service/host.ts`。 | 之前“全部插件/写入均纳入 P5”的说法不成立；需按实际副作用盘点。 |
| G9 | 普通 `before-quit` 先停 Service；更新则先 `quitAndInstall()`，再依赖退出事件停 Service。已安装的 `electron-updater/out/BaseUpdater.js` 是先 install，再请求 app.quit。 | 既会影响 renderer 退出否决，也不能保证安装前停服；必须单独修正并做进程级验证。 |
| G10 | 仅有标准 Node 不等于具备 npm、Git、Bash、rg/fd；SDK grep 的工具获取还有独立行为。见 SDK `utils/tools-manager.js`。 | 分清核心运行条件与功能工具条件，不能把“Node-only 可启动”写成“所有外部工具零前提”。 |
| G11 | `publish.yml` 只构建 Next 后 publish；Web CI 只构建 UI。 | 恢复真实 npm 包安装验收，发布必须发布被验收的同一个 tarball。 |
| G12 | `lib/draft-store.ts` 的聊天草稿仅在 renderer 内存 Map 中；文件草稿保护并不覆盖未发送消息和附件。 | 更新关窗前必须同时保护聊天草稿，不能指望恢复窗口后内存还在。 |
| G13 | 现有 `proper-lockfile` 以 mtime 判 stale，会接管超时锁；mtime 过期并不证明一个被暂停的 owner 已死亡。 | Service 生命周期互斥不能直接照搬包/设置文件锁的超时接管策略。 |
| G14 | 当前包同时包含 `.next`、`next.config.ts` 与 public；依赖又分在 dependencies/devDependencies。见 `package.json`。 | 生产 Web 闭包不仅是 Service：还需核验 Next 配置加载、SSR 外置模块、字体/静态资源及目标平台 Next 依赖，不能假定构建会把所有 devDependency 都内联。 |

补充核查：当前 Service 闭包为 177 个包，其 manifest 未发现 os/cpu/libc 限制或 optionalDependencies；Pi TUI 包内有多平台预编译文件。这只是采用统一 JS 产物的有利证据，不能代替 Windows/Linux 安装与动态资源测试。

## 3. 实施前的明确选择

以下是本计划的推荐执行基线。批准计划不等于授权系统安装、覆盖真实用户版本或发布。

### D1. 代码一致，不要求所有目标的依赖目录字节一致

- 一份 Service 编译图、一套业务协议、一套最小生产依赖清单。
- Desktop/独立归档可带目标闭包；npm 用正式的 npm 依赖打包规则表达闭包。
- 不把从开发机复制出的目录直接称为“通用跨平台 Runtime”。
- Service 只按自身产物和标准模块解析定位资源；Host 可以定位 Service 文件，但资源根不能反向依赖 Electron 安装布局。
- 仅提取实际共享的构建、启动和包初始化部分；不大规模搬迁现有业务源码。

### D2. 保留单一 npm bin，定义三种显式模式（attached 分本地/远程）

拟定命令合同：

| 命令 | 所有权和行为 |
| --- | --- |
| `npx @weclio/web` | 本地 managed：启动自有 Service + Web UI；启动失败回收自有进程。 |
| `npx @weclio/web service` | 只启动独立 Service；无 Web/Electron；可供标准进程管理器运行。 |
| `npx @weclio/web --service-url <origin> --token-file <absolute-path>` | 本地 attached：只启动 loopback UI，用显式文件凭据校验指定 Service，并按 D4 本地信任模型引导浏览器；绝不接管或停止它。 |
| `npx @weclio/web --service-url <public-origin> --hostname <bind-address>` | 远程 UI 模式：非 loopback 时不得携带 token-file 自动下发；只提供公开地址，浏览器用户输入凭据并自行验证连接。 |

- 仍保留 `weclio-web` 为唯一 bin，参数解析需覆盖 subcommand、未知参数与互斥组合。
- Desktop 首轮保持“管理自有本地 Service”；不顺势做远程连接管理 UI。
- 同一 Service 可以有多个 HTTP/SSE 客户端。所有任务与写入门禁必须覆盖其他已连接客户端，不能只看 Desktop 当前窗口。
- attached 不自动扩大 CORS：Desktop 管理的 Service 启动时明确允许 `weclio://app` 及本机 Web 默认源 `http://127.0.0.1:8888`；其他源/端口必须由操作者在启动 Service 时显式配置。不允许任意带 Token 的客户端动态注册来源，不通配回环端口。用该默认组合验收 Desktop + attached Web；自定义端口被拒时给明确 allowlist 指引。

### D3. 分发策略先做真实包证明

- 发布包包含编译后的 Service 代码；Service 运行依赖转为真实 production dependencies，包括当前在 devDependencies 的 `mammoth`。
- 用 `bundleDependencies` 显式纳入 Service 的直接依赖及 npm 实际遍历到的闭包；不用 `files` 硬塞一个假定完整的嵌套 node_modules。
- npm 产物与 Desktop 产物均校验依赖版本、嵌套版本和运行资源；原始 package-lock 不会自动成为发布包消费者的锁，不能据它宣称消费者图已锁定。
- 在隔离发布 staging 中生成并校验用于 CLI 分发的 npm-shrinkwrap，保留目标平台所需的可选依赖元数据；不在开发工作区重写锁文件。
- 同时核验 Next 生产配置、SSR 跟踪外置模块、字体/public/静态 chunks 与目标平台 Next 依赖；需要的现有包进入 production 清单。消费端不需要开发依赖、TypeScript 编译器、源码或安装后再 build UI。
- Web/Service 的 production 图移除 Host 专用的 `electron-updater`；Desktop 构建仍从已有 build/dev 依赖组装独立 Host 闭包。
- 独立 Service 归档选择“解压后可离线启动”，而不是首次启动再 npm install：包含同一编译代码、最小 package.json、已锁定生产闭包、SDK/种子资源和许可证；按经过验收的 OS/arch 标注。
- 该归档不含 Next/Electron/Host，也不通过“安装整个 UI/Host 后忽略它们”来冒充部署独立。归档、Desktop、npm 消费安装的 Service 源码摘要及包名/版本清单必须匹配；平台资源差异单列，不冒充逐文件完全相同。
- 不新增注册表包名或新供应商依赖。以上策略必须先通过真实 pack/install spike，再改正式发布链；失败则停在本阶段，不绕过门禁。

### D4. 运行时连接引导只管连接，不承载业务

- 引入一个薄的、标准 Node 的 Web UI 宿主，复用 Next request handler；开发/生产共用连接合同，不更换 Next UI。
- 该宿主处理唯一的连接引导入口，再把 UI 请求交给 Next；不增加 Next 业务 routes，不放宽既有 UI-only build guard。
- 好处是可在真正持有 socket 的层检查监听、peer、Host、Origin，而非相信可伪造的 forwarded headers。
- React 在拿到有效连接并完成协议校验前，不挂载业务组件；失败显示错误或连接表单，不回退 `/api`。
- Desktop 继续使用可信 preload；业务 Service 不为不同 Host 分叉。
- 凭据不固化进公共 JS、不写日志/长期 URL/浏览器持久化存储；连接 JSON 使用 no-store/nosniff，不提供 JSONP 或跨源读权限。防嵌套策略加在 UI 文档上，不只加在 JSON 上。

**必须显式确认的信任取舍：本地自动模式按可信单用户机器设计。能直接访问该本地监听器的进程/其他本机用户可能获得其自动连接凭据；loopback、Host、CORS 不是 OS 用户认证。不能宣称它隔离了同机恶意进程。**

- 自动模式只允许直接 loopback，不支持作为远程反代后端；非 loopback 监听不能只是打印 warning 后继续发 Token。
- 远程 UI 模式只公开可公开的连接地址；浏览器用户自行输入凭据，不把服务器保存的共享 Token 无认证地下发。本地 attached 使用 token-file 时仍属前述可信 loopback 自动引导，不把两种模式混为一谈。
- 若要求同机多用户强隔离，应在实施 D4 前改为明确的配对/认证方案；不能偷偷加 Cookie、长期 URL 密钥或凭据库补洞。
- 远端浏览器获得的地址必须是它可达的 Service 地址，不是服务器自己的 127.0.0.1。公网 TLS、反代访问控制是部署前提，不因本计划有 Bearer 就宣称公网暴露已安全验收。

### D5. 系统 Node 选择与外部工具

- 可信 Host 的显式绝对 Node 路径优先；Node 启动的 CLI 可使用已验证的当前 executable；Desktop 从继承 PATH 的绝对目录解析标准 node.exe/node。
- 不以 Desktop 当前 process.execPath 代替系统 Node；不搜索任意当前目录、执行 shell profile 或偷偷安装 Runtime。
- 启动探针确认实际 executable、Node 版本和标准 Node 身份，再固定该路径创建 Service。版本判断由 CLI、Desktop、Service 共用。
- Windows PATH 大小写键合并；把已选择的 Node 目录放到子进程 PATH 前部，防止工具又调用另一个 Node。npm/npx 单独检测并测试 Windows cmd 启动语义。
- GUI PATH 不可见时给出重启应用/配置绝对路径的提示，不假设系统一定安装在固定目录。
- 保留 HOME、Pi agentDir、代理、CA、Git/Bash 环境；清理宿主遗留和注入型 Node/Next 环境。不要把“清理环境”做成丢失企业代理/证书配置。
- 不在这次抬升现有最低声明 22.19.0；先验证最低版本及 22/24/26 候选线，最终支持声明、engine 与运行时检查取交付实际通过的范围。不宣称未跑过的新 major 已认证。
- Node 为 Service 运行前提；npm/npx 为包管理能力前提；Git/Bash 为对应工具前提。缺工具不伪装成功，不用 PowerShell 冒充 Bash。
- 继续保留 Desktop 的 rg/fd 工具资源；删除 Node/npm 资源不等于删除所有 tools。Web/独立部署明确工具前提和既有 SDK 按需获取行为；离线缺工具必须有准确错误。

### D6. 数据、同机共存与所有权

**推荐规则：同一个规范化 Pi agentDir 同时仅一个 Weclio Agent Service 写者。需要 Web 与 Desktop 共用现有数据时，先让 Desktop 管理 Service，再用 Web 显式 attached 模式连接。**

- 不自动 attach 陌生 endpoint；不因端口被占用就认为找到了自己的 Service。同 profile 第二个 managed 启动明确说明冲突及显式 attached 的使用方式，不回显 Token。
- 保留现有 Desktop userData、独立 Service stateDir、Pi agentDir、session 路径及包初始化 receipt；不通过新建默认 profile 隐藏旧数据。
- profile lease 和 stateDir lease 采用固定顺序（先 profile 后 stateDir），早于包初始化和任何持久化业务写入。
- Service 生命周期互斥采用进程存活期的本机 OS 互斥端点：规范化目录摘要对应 Windows named pipe / Linux abstract Unix socket，通过标准 Node net API 独占；端点不提供命令、凭据或业务服务，只占有并拒绝连接。E0 必须证明目标平台排他性与异常退出释放；不能以 mtime 超时、PID 记录或可读文件存在充当排他性的依据。不支持跨机器共享 profile/NFS 锁承诺。
- 进程暂停仍持有互斥；死亡由 OS 释放。磁盘 owner 记录仅用于身份诊断，清理须核对 instanceId；旧 owner 不能释放新 owner 的端点。原有 Pi 包/设置锁继续使用现有锁依赖，不改 SDK 锁语义，不建锁服务器、数据库或通用租约框架。
- 测试目录别名、并发启动、暂停活 owner、崩溃残留、旧 owner 迟到清理、部分启动失败和安全释放；不能按 PID 名称批量杀进程。
- 该约束只管 Weclio Services，不宣称控制外部 Pi CLI/npm；继续保留 Pi 自己的包/设置锁，不允许多进程并发修改同一会话的承诺。
- 已初始化/用户已删除或禁用的内置包不因改名、换启动入口或升级而被恢复。
- 所有写入在用户数据/工作区，包安装目录、npx cache、只读 resources 和源码目录不能承担用户状态。

### D7. 维护准入与退出顺序

先建立副作用清单：SDK 提示/排队/启动/尾任务/压缩/bash、自动标题、插件安装更新删除启停、技能操作、设置/认证写入、文件保存上传及响应返回后的后台任务。

- 异步工作必须在首个副作用前占位，真正结束后 finally 释放；只读 GET 不能仅因没有 POST 名字就被当作无副作用。
- 维护锁检查所有相关进行中工作，并原子拒绝新工作；维护拒绝返回稳定的服务不可用错误，不再用通用 500 冒充内部崩溃。
- 不把长连接 SSE 本身计为永远 busy；读流、文件描述符、下载与写入的关闭/等待语义分别测试。

**更新顺序：**

1. 验证下载产物，预检查 busy；busy 则不关窗口。
2. 请求真实窗口关闭，Service 此时仍可保存；文件 dirty/saving/failed 和任何未发送聊天草稿/附件（包括已切走会话）均否决更新关闭。检查实时编辑器与完整 draft-store，而非只检查当前可见文件。首轮不新增聊天草稿磁盘持久化；用户先发送/清空后重试，不绕过 beforeunload，不在窗口还活着时停后端。
3. 窗口确实关闭后，再原子 lock。其他客户端在两步间提交工作时，lock 必须拒绝，随后恢复窗口；不能仅依赖先前 inspect。
4. lock 成功后停止入口、等待受管工作收尾并确认自有 Service/相关自有写入进程退出。
5. 只有确认停止成功后才调用 installer handoff。退出事件只作幂等兜底，不承担“安装之前”的排序。

这与上一版“先 lock 再要求草稿保存”不同：不制造自动保存被维护锁拦住的死锁。

**普通退出：** 先保留忙任务选择与 renderer 草稿否决；接受退出后才停止自有 Service。聊天草稿只有用户主动清空或明确选择放弃时才可丢弃，不能因只保护文件草稿而静默丢失。用户取消时后端必须仍可用。CLI Ctrl+C 属于明确停止自有应用；attached 模式不停止外部 Service。

**失败合同：**

- 关闭被否决：不停止、不安装，窗口继续工作。
- lock 失败：不安装，恢复可用窗口；不自动取消其他客户端任务。
- drain 超时/退出结果未知：不启动安装器；有限时间内明确报错。不能一边旧进程未确认退出一边拉起竞争写者。
- 已进入不可逆 drain 的进程不能假装 unlock 就恢复；必要时先确认其结束，再启动替代进程。强制终止必须仅针对自有树且明确告警，不算干净退出。
- 安装器启动失败：若旧 Service 活着且可用则解除维护，否则重启；更新地址、Token、实例身份与 CSP 配置后再恢复窗口。
- 整个恢复流程可重试、可失败退出；不无限重启、不遗留半关闭界面或僵尸进程。

## 4. 执行阶段与停止门禁

### E0 — 冻结合同并建立最小分发证明

交付：上述命令/所有权/信任边界合同、支持矩阵，以及隔离 staging 内最小 pack/install 验证。

- 确认本地自动引导采用 D4 信任模型、同 profile 采用 D6 单写者规则；若不接受，先改计划，不让代码猜。
- 证明单一 bin 仍能被 npx 自动选择。
- 证明编译 Service + npm 正式 bundle 规则能保留实际 SDK 资源及完整版本图；确认消费者只装 production dependencies 仍可加载 DOCX、包初始化、Next 生产配置/SSR 与完整 UI 静态资源。
- 证明目标平台和 shrinkwrap/bundle 组合可安装，并证明本机 OS 互斥端点的排他/暂停/崩溃释放语义；不发布、不覆盖真实安装、不联网发送模型请求。

本轮已做的有限预验证：`build/regression/standard-node-lease-probe.mjs` 在 Windows / 系统 Node 24.16.0 下，以随机本地端点和自有子进程验证了“owner 事件循环阻塞时第二个进程不能取得端点、强制结束该 owner 后可重新取得”。结果通过；不是完整 Service 所有权实现，也不替代 Linux、目录别名、部分启动失败和全部支持版本的验收。

E0 进展：两项产品边界已确认。Windows 系统 Node 24.16.0 下，Service-only npm 探针 tarball 解包后保留了 177 个依赖的清单版本及 SDK WASM；隔离环境启动后，通过认证 `/v1/info` 核对实例身份、验证离线内置包初始化和退出码 0。探针证明嵌套 Service 闭包可以进入包，但不等于正式 `bundleDependencies` / 锁策略已通过，也不能代替 npm 消费安装或 Next 验收。完整 npm 消费安装仍未通过：本机在限定时间内未完成。npm 12.2.2 拒绝 `shrinkwrap` 命令；本机 npm 11.13.0 接受该命令，正式发布工具链不能继续假定 `npm@latest` 可执行所有步骤。

验证隔离要求：任何探针 `npm install` 都必须先在专用目录生成 package.json，传绝对 `--prefix` 并验证 `npm prefix`，清理继承的 `npm_*`，使用专用 npm 配置。仅切换 cwd 不算隔离。早期探针误写入用户主目录；相关进程已停止，匹配探针版本/依赖路径的产物已隔离，没有接触 Pi 会话或凭据。

已冻结产品边界；Windows/Linux 消费安装及 Linux 互斥验证移至产物门禁，不阻塞实现。当前 Web 候选包沿用已实测可打入 tarball 的嵌套 Service 闭包；以实际消费安装结果决定是否需要改变依赖打包方式。

### E1 — 中立 Service 产物与共享生命周期基础

主要范围：现有 `electron/service-build.mjs`、`electron/package-files.mjs`、`electron/packages.mjs` 中实际共享部分；`lib/agent/service/entry.ts`、config、锁与启动测试。

交付：同一 JS 产物、标准依赖解析、原子 profile/state 所有权、兼容初始化、managed/standalone 明确模式。

验收：仓库外、非安装目录 cwd、只读产物、隔离 HOME；系统 Node 启动解压后的独立归档，无 Next/Electron/首次 npm install；SDK 动态 TS 扩展、额外依赖、worker/WASM、HTML 导出模板、内置包离线初始化；两进程并发抢 profile 仅一个成功，失败方无用户数据写入；暂停活 owner 不被接管，进程死亡后可重启，旧清理不影响新 owner。

### E2 — 完整生产 Web 与运行时 bootstrap

主要范围：`bin/weclio-web.js`、options、薄 UI host、`lib/api-bootstrap.ts`、UI 初始配置门禁及 dev supervisor。

交付：managed 默认启动、独立 service 子命令、显式 attach、运行时连接合同和错误界面。Next UI-only 检查保持严格。

验收：本地 managed/attached 在 Service READY + 认证/协议校验后才宣告完整可用；远程 UI 模式在浏览器输入凭据并通过校验前明确为未连接，不冒充完整就绪。地址与端口不匹配、token 错误、跨源拒绝、UI 启动失败、Service 中途退出均不留半成品；刷新/多标签页仍能正确引导；第一次未配置时零业务请求；关闭浏览器标签页不停止 CLI Service。额外跑实际 Desktop 管理 Service + attached Web 的 CORS/身份/任务测试，不把只对 standalone 成功当作共存成功。

安全验收：错误 Host、null/恶意 Origin、伪造 Forwarded、DNS rebinding Host、跨源 fetch/script/iframe、不安全非 loopback 自动模式都被正确处理；日志、JS chunks、source map、URL、localStorage/sessionStorage 不出现长期 Token。直接本地客户端的能力按 D4 如实声明。

### E3 — Desktop 系统 Node 与实际退出/更新顺序

主要范围：`electron/local-service.mjs`、runtime、main、update-install、build、builder、release 及关联测试。

交付：系统 Node resolver、共享 Service 管理、D7 生命周期。移除 `node-runtime.mjs` 的生产调用及 Node/npm 资源映射、准备脚本、发布指纹、已失效测试；保留工具资源与独立 updater Host。

验收：双击实际打包 app 而非仅命令行启动；Node 缺失/过低/路径空格/多版本/GUI PATH 缺失/宿主环境污染均可诊断；Node、npm/npx、TS 扩展与 CLI 子工具使用正确环境；installer 启动前 Service PID 确实已退出；恢复后真实 HTTP/SSE 可继续用。

### E4 — 真正的分发与平台门禁

- 同一个 staging 构建 UI/Service、生成清单与锁、产出 tarball；检查文件清单和禁止依赖。
- 将该 tarball 传到 Windows/Linux 干净安装测试；不复制构建机 node_modules 充当消费安装，不借开发仓库。
- 通过后发布同一个已验收 tarball，不再次从可能变化的工作区执行 publish 重打包。
- Desktop 使用同版本 Service 代码/清单，单独验证其目标闭包和资源布局；确认无额外 Node/npm Runtime，也没有运行时 Electron ABI 重编译 Service 依赖。
- 发版门禁串联 E1–E3 的进程级测试，不能因默认 skip 而显示绿色。

### E5 — 最终发布候选验收

完成下方矩阵、只读代码复核、全量回归、lint、源类型检查和 diff 检查；文档以实际命令与实际已测平台为准。

然后才进入真实 NSIS 安装/升级测试。覆盖安装、系统安装、新 Windows 用户/VM、签名、发布及 push 均另行授权；没有环境或授权时记录明确缺口，不把另一目录的解包候选当成真实升级已通过。

## 5. 必须通过的最终矩阵

| 维度 | 必测场景 |
| --- | --- |
| 默认 Web | 从 tarball 安装，以与用户 npx 相同的 bin 推断执行；界面、会话、HTTP/SSE、真实 fake-model 工具循环均工作。 |
| 发布证据 | tarball 文件清单、Service 版本/资源清单、消费者已安装依赖图一致；无开发 Token、真实凭据或构建缓存。 |
| 独立性 | Linux/Windows 系统 Node；无 Electron、Next、UI 和源码仍可运行独立 Service 归档；stdin EOF 不关闭 standalone。 |
| Node | 现有最低版本与所声明支持线；找不到、无执行权限、错误 Runtime、PATH 别名与多版本。 |
| npm/工具 | npm/npx 的实际执行及本地 fixture 插件安装/更新/卸载；Git/Bash 与搜索工具存在/缺失/离线；没有 paid prompt。 |
| 业务回归 | SSE 断线重连、Last-Event-ID、持久化/重启、fork/context、Blob 图片、Ticket PDF/音频/下载、Range、DOCX。 |
| 数据兼容 | 旧 Pi 会话/配置、用户删包/禁用选择、旧 receipt、只读/中文/空格路径、升级不清空数据。只用复制的 synthetic fixtures，不读取真实 profile。 |
| 并发所有权 | 不同 stateDir 同 agentDir、同 stateDir、多进程同时启动、符号链接/目录别名、暂停活 owner 不被抢占、崩溃后恢复、旧 owner 迟到清理不破坏新实例。 |
| 多客户端 | 一个 Service 同时有 Web/Desktop 客户端，任一客户端启动任务/写入都影响维护锁；客户端退出不误停外部 Service。 |
| 普通退出 | idle、busy、取消退出、文件草稿 dirty/saving/failed、当前/后台会话未发送聊天和附件、保存完成后退出、明确放弃草稿、父进程异常关闭。 |
| 更新 | busy 拒绝、聊天/文件草稿真实 close 否决、关窗后 lock 竞态恢复不丢未发送内容、长请求/包任务、drain 超时、installer 同步/异步失败、恢复后再次更新。 |
| 清理 | 只停止自有进程/子树；确认退出而非仅发送 kill；原开发服务和无关 Node/Electron 不受影响。 |
| 真安装 | ASAR/资源布局、全新安装、旧版本 A→B、重启后旧数据；记录实测环境与未验证部分。 |

每条产物测试记录版本/提交、OS/arch、精确 Node/npm 版本、产物摘要、退出码及隔离日志。不要用 screenshot 或 READY 单行替代功能断言。

全量测试继续限制 `--test-concurrency=4`。Next 生产构建在独立 staging，不触碰正在使用的开发输出。所有进程测试使用隔离 HOME/agent/state/workspace 和本地模型 fixture；不接触真实凭据/会话、不发付费模型请求。

## 6. 完成定义

只有以下全部成立才称本轮收敛完成：

- 用户默认生产命令完整可用；不是“服务能启动但浏览器没接上”。
- Service 标准 Node 独立部署、两个客户端协议和业务语义一致。
- Desktop 确实使用系统 Node；安装包不再包含额外 Runtime。
- 所有权、凭据边界、写入准入、退出与更新失败恢复都有行为断言，而不是正则/源码结构测试代替。
- 被发布的就是跨平台消费测试已验收的 npm 产物；真实 Desktop 安装/升级结论单独明确。
- 没有偷偷扩大到远程平台、多租户或新的认证基础设施。Linux 独立运行通过不等于公网生产部署、跨主机 provider OAuth 回调或多租户隔离已验收；这些不在本轮完成声明内。

不满足时明确标注“实现完成、某项验收未完成”，不再用“P5 完成/只剩打包”掩盖生命周期缺口。

## 7. 核查来源与限制

本计划依据当前仓库所列入口、配置、测试及本机安装的 SDK、npm、electron-updater 源码和 npm 随附文档；另有 E0 所记 Windows 互斥探针，未执行产品测试或构建。未假定公开 registry 的某个版本等同本地分支；此前公开 registry 查询未取得发布包，本轮没有安装或验证线上包。外部官方站点访问超时，因此不沿用上一轮未经本轮工具核验的网页引用，也不编造引用 ID。

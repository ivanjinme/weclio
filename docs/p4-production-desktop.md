# P4：Desktop 生产闭包与内置 Runtime

## 状态与范围

P4 代码、候选资源构建和仓库外真实进程验证完成。目标是新版 Desktop，下一步 P5 更新准入/生命周期，再做 P6 安装升级和发行；不以 VM 或 Web/Service 单独部署为门槛。

这不是发布验收：尚未构建/安装 NSIS、验证新布局的 ASAR 启动或真实 A→B 升级；更新安装仍因缺真实门禁而拒绝。没有签名、发布或推送。

## 产物与职责

```text
resources/
  ui/                         Vite 静态 UI
  service/entry.mjs            普通 Node 入口
  service/lib/                自有源码运行时引用图，编译为 ESM
  service/node_modules/       SDK/转换器/内置包的运行时闭包
  host/node_modules/          独立 updater 闭包
  runtime/win-x64/node/       官方完整 Node/npm/npx/shims/许可证
  runtime/win-x64/tools/      rg/fd
  desktop-toolset.json
```

- `electron/service-build.mjs`：编译自有 value-import 图，移除 type-only imports，重写本地别名/扩展名；不把 SDK bundle 到一份 JS。锁校验后收集177个运行时包，另为 Host 收集16个包。
- 不能按根 `devDependencies` 标签盲删：DOCX 预览实际依赖 `mammoth`；SDK 的动态 TS loader、额外用户依赖、WASM/worker、主题、HTML export 模板、技能脚本及许可证必须保留。
- 自有编译源码和 SDK 完整文件布局分开；Service 不携带 Next、React、Electron 或 TypeScript 编译器。SDK 自带的 TS 扩展 loader 仍正常工作。
- 既有内置包离线播种在 Service 内执行，保留 receipt、Pi 配置锁、原子发布和用户选择；没有新增默认 Plugins/Skills。
- `build.mjs` 不再构建 Next，候选 UI 输出到 `build/desktop/ui`，不触碰开发实例的 `build/desktop-ui` 或 `.next`。旧 `production.mjs`、Next HTTP supervisor 及其专用测试已退役；有意义的启动/身份/清理行为迁入新的 Service 测试。
- Builder 分别映射 Service、Host 和 npm 的 `node_modules` 根，防止默认过滤丢依赖。updater 从 `resources/host/package.json` 解析，不借用 Service。

## Runtime 与启动

- `electron/node-runtime.mjs` 固定官方 Node **24.16.0 / npm 11.13.0** 完整 Windows x64 ZIP、官方来源及 SHA256；下载后先验证 ZIP，再解压、验证 Node EXE 摘要并记录完整文件树。升级 pin 需要重新做产物回归。
- 仅准备项目的 ignored 资源/缓存，不安装系统软件，不修改系统 PATH。实际启动用绝对路径的 bundled `node.exe`，不用系统 Node，也不用 `ELECTRON_RUN_AS_NODE`。
- Service PATH 优先包内 Node/npm，其后保留用户 Git/Bash，rg/fd 仅兜底；清除大小写变体的 Node/Electron/Next preload 污染。Git/Bash 不随包提供，不能把 PowerShell 当成等价替代。
- `local-service.mjs`：要求资源齐全，验证 Runtime 后启动自有子进程；等待 READY，再核对受认证 `/v1/info`、Service/instance ID、子进程 PID 和协议。任何不匹配都停止本次子进程并失败，不接管陌生进程，不回退系统 Node。
- 安装态 Main 自行启动 Service；开发态仍由 supervisor 用系统 Node 启动。连接信息只经拥有窗口的**主 frame** 获取，不信任同 URL 的子 frame 或其他 WebContents。
- 明确托管时才将父 stdin EOF 当作关停信号；普通独立 Service 不依赖 stdin 存活。空闲正常退出已验证子进程结束且 owner 记录清除；完整 busy/update/draft/失败恢复在 P5。

## 真实验证发现的下载缺陷

跨源 anchor 下载被 Desktop 的严格导航保护阻止；不能通过放宽主窗口导航修复。

新增窄 `resource:download` IPC：同一可信主窗口/主 frame、已选 Service origin、精确 `/v1/resources/content` 路径、唯一且非空 ticket 查询，无凭据/片段；不接受任意 URL、请求头或本地写入路径。Ticket 仍由正常 SDK Bearer 请求签发，Service 兑换时仍做同一资源授权。Desktop 用 `webContents.downloadURL`，Web 保持原生 anchor；桥接错误不暴露 Ticket URL。

真实候选中点击同一个 UI 下载按钮，文件完成后与隔离工作区原 PDF **逐字节相等**。

## 验证证据

- 全量：971 tests / 960 passed / 11 skipped / 0 failed（concurrency=4）；lint 无警告/错误，源码 TypeScript167 roots 通过。另显式跑产物集成测试1/1通过。
- 产物集成测试在普通测试中有意默认跳过，但发行完整/quick 路径都显式提供候选目录与 Runtime，强制运行，不再允许跳过。
- `service-artifact.integration.test.mjs`：产物与完整 Runtime 复制到仓库外的空格/中文路径，隔离 HOME，PATH 不含系统 Node/Git，清除 NODE_PATH；只用本机模型 fixture。
  - 真实 write → edit → read 工具循环，文件由 FIRST 改为 SECOND；最终回复/持久化历史正确。
  - TS 扩展加载自身 `node_modules` 额外依赖、调用并 reload；不借仓库 TypeScript 或 node_modules。
  - SDK 自己的 HTML exporter、主题与模板读取成功，解码其内嵌 Base64 会话包含真实循环；SDK 图片 worker/WASM 完成32×32→1×1处理。不是新增产品 export API。
  - 原有两内置包离线初始化成功；控制关停返回 `timedOut:false`、退出码0。
- prepared Runtime：Node/npm/npx/子 Node 在 PATH 仅 System32 + bundled Node 时通过，`process.versions.electron` 不存在。
- 真实原生候选：复制已安装 Electron 分发文件、使用真实安装目录布局和可执行文件命名，**原生 `app.isPackaged=true`，未伪造 packaged/resourcesPath**。按实际 Builder FileMatcher 复制资源并校验完整 Runtime；用户 profile 在候选安装目录之外，隔离于真实用户。
  - Host updater 能从独立闭包加载；Main 启动资源内 Node/Service；聊天/SSE、Blob 图片、原生 SVG、sandbox DOCX、原生 PDF、206/32字节 Range、音频元数据均通过。
  - 原生下载文件逐字节比对通过；UI 只请求选定的 Service，无 `/api`。
  - 空闲退出后自有 Service 不再存活、owner 记录不存在；未停止用户开发实例。
- 自动化窗口的后台/音频节能策略会影响实际播放时序，本轮音频验证为 readyState=4/元数据；不把它写成完整可见窗口播放验收。
- 独立只读审查未发现代码级缺陷；指出的安装说明漂移已修正，建议的强制产物测试发行门槛已补入。

本机证据在 ignored `build/regression/`：`p4-desktop-build.log`、`p4-isolated-artifact.log`、`p4-full.log`、`p4-browser-proof.json`、`p4-resource-proof.json`、`p4-bundled-desktop.png`。Node ZIP/资源二进制不进 Git。

## 尚未宣称完成

- P5：真实原子更新准入、忙任务/草稿否决、窗口确认关闭后有序停 Service、安装器失败恢复。
- P6：干净环境的实际 NSIS/ASAR 启动、旧会话/设置/凭据/包保留、A→B 升级、发行命名/源与签名清单、最终发布授权。
- 干净 Windows VM 未实际安装；无系统 Node PATH 的本机隔离验证不等同于完整新机器验收。
- 未用真实 provider/OAuth 凭据，不向真实模型发送回归提示。

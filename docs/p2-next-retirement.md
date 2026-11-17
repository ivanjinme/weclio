# P2：Next 业务后端退役记录

## 结论

用户已明确验收 P1；P2 源码、自动测试和本机隔离浏览器回归完成，生产 UI 构建验证待用户授权，之后进入 P3。Next 只提供 UI，业务 HTTP/SSE 只在独立 Service 执行。不新增代理、旧路径回退、运行时双模式、依赖或远程基础设施。当前不是可发布安装包。

## 实施范围

- 删除39个 `app/api` 业务 handler，覆盖 Agent、会话、文件、工作区、Git、模型/凭据、OAuth、资源安装、用量查询。删除 Next 专用错误适配、proxy/请求安全模块和 instrumentation。
- 删除 `getDefaultRuntime`、旧 wrapper 入口、HMR/global admission/OAuth manager、旧 Next 更新 IPC 门禁；Service 显式持有 `AgentRuntime`。进程信号由 Service entry 管理，Pi SDK 自己的清理不重实现。
- HTTP proxy/idle dispatcher 移至 Service bootstrap。Next 不再配置模型出站网络，也不能返回 Agent 空闲/可更新状态。
- 客户端只生成 Service 路由，必须显式选择目标，拒绝 `/api`。未配置时显示提示且不挂载会发业务请求的界面；仅有 token 不会隐式选择后端。少量 UI 历史后缀仍在客户端转换，不是服务端别名。
- 资源客户端只保留 bounded Blob / Ticket，无旧 Next 的匿名原生直读分支；自动凭据仍仅限已选 origin/path。
- Desktop/Web 开发共用一个 supervisor：系统 Node 的 Service → Next UI → 可选 Electron；GUI 等本次 UI ready+HTTP 后启动，正常退出联动清理自有进程，不终止其他 Node 或删除缓存。
- 生产 UI 启动入口检查编译 manifest，拒绝旧 API/route handler/instrumentation 产物，不能因源码已删就复用旧 `.next`。未执行生产构建，也未删除旧产物。
- 生产 Next 不再开更新 IPC 或提供假的 `ready`；安装器在缺失真实门禁时拒绝安装。Service 更新管理接线留到 P5，未声称该中间态可发布。

## 测试迁移与修正

旧 Next 专用适配器测试退役；有效行为转入共享服务或真实 Service HTTP，保留 SDK startup/persistence、文件/Git 安全、会话 mutation、OAuth/SSE、自动命名和执行准入覆盖。

迁移暴露并修复：无效 titles body 的500改为400；Service 文本写入复用既有 text/plain/256KiB/UTF-8 有界读取规则。相关无效请求不修改文件。

新增边界测试追踪 Next/UI 的完整本地 value-import 图（忽略 type-only），禁止触达 Pi/服务端业务模块；检查 app 无业务 handler、instrumentation 无 Agent 门禁。旧编译产物与缺失/损坏 manifest 均拒绝启动，合法当前页面 manifest 的 fixture 通过。

- 全量：957 tests / 947 passed / 10 skipped / 0 failed（concurrency=4）。
- ESLint 无警告/错误；源码 TypeScript167 roots 通过。开发树仍可能含旧生成 validator，不把它算作源码错误或擅自清缓存。
- 独立只读代码审查：No findings。审查未独立重跑测试；实际新生产 Next build 尚未验证。

## 真实进程/浏览器证据

使用隔离 HOME、agentDir、state、workspace 和本机模型 fixture，无真实 provider 调用或凭据修改。

1. 配置 Service 的 Next UI：新建会话、发送、显示 `P1_LOCAL_FIXTURE_OK` 和 Blob 图片通过；历史正常；原生 Ticket SVG 正常解码，浏览器无异常。
2. 未配置 Service 的独立 Next UI：清楚显示配置提示，页面完成后 performance 记录中 `/api/*` 与 `/v1/*` 业务请求数为0。
3. 实际 UI 上 `/api/sessions`、`/api/agent/running/events`、`/api/models`、`/api/files/test` 均404，无 tombstone/proxy/fallback。
4. 用户自行重启的 `npm run dev` 日志确认 Service8899 READY、UI8888 ready/200、Electron 首帧及会话恢复。只读检查；没有停止该进程，重启前错误已被日志覆盖，未猜测其原因。

本机未提交产物：`build/regression/p2-chat.png`、`p2-config-required.png`、`p2-full.log`、`p2-e2e.log`、`p2-ui-only.log`。测试实例已清理；用户开发实例保留。

## 尚未声称完成

- 新生产 UI 构建的真实 manifest 与无旧后端产物验收（目前 guard 验证使用 fixture）。
- Electron 完整人工功能回归、真实 provider/OAuth；不把 fixture 或用户一次成功启动当成全部通过。
- P3 静态协议、所选 Service 来源 CSP；P4 独立 Runtime/Service 产物；P5 真正的 Service 生命周期/更新准入；P6 安装升级与发行。

没有构建、安装依赖、打包、发布或推送。旧已发布安装包未被改动；当前分支中间态不得用于发行。

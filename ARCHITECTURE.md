
## System Architecture


```text

       Desktop (Electron)                Web (Browser)
                │                             │
                └─────────────┬───────────────┘
                              │ HTTP ↓ / SSE ↑
                              │
    ┌─────────────────────────┼────────────────────────┐
    │ Runtime Environment     │                        │
    │ (Local / VM /Sandbox)   ▼                        │
    │                ┌───────────────────────────┐     │
    │                │ Agent Service             │     │
    │                │                           │     │
    │                │ ├── HTTP API / SSE         │     │
    │                │ └── Pi SDK (in-process)    │     │
    │                │     ├── AgentSessions      │     │
    │                │     ├── Extensions         │     │
    │                │     └── Tools              │     │
    │                │         (read/write/edit/  │     │
    │                │          bash)            │     │
    │                └───────────────────────────┘     │
    └──────────────────────────────────────────────────┘

Deployment (future direction — only Local ships today; Remote and Scale are on the way):
  Local  → Agent Service on user's machine
  Remote → Dedicated VM / container / sandbox per user
  Scale  → Multiple isolated runtime environments, each with its own Agent Service
```

- Desktop 与 Web 都只是 UI：连接已选定的 Agent Service，走 HTTP/SSE，不加载 Pi SDK，不另起运行时，也没有进程内捷径或代理。Desktop 用 `weclio://app` 加载 Vite 静态构建，因此没有 UI 服务进程，页面也不经 loopback HTTP 提供。
- UI 不猜测默认地址，也不自动发现 Service。宿主可以启动自己的 Service，但不会自动发现或接管其他实例。宿主须明确提供地址与凭据，缺失则报错；Desktop 通过受限 IPC 提供。AgentRuntime 由 Agent Service 进程创建并持有，不是 UI 进程或框架热更新里的单例。
- Pi 拥有 agent 执行、会话持久化与树语义、模型上下文构造；不要重新实现。
- Agent Service 只跑标准 Node.js。宿主可管理自己启动的 Service，但同一产物也可独立运行。
- 同一份 Pi 数据同一时刻只允许一个 Agent Service 写入。

## Current Code Entrypoints

| Concern | Start here |
| --- | --- |
| Runtime lifecycle, commands, fork, compaction | `lib/rpc-manager.ts` |
| Persisted-session queries, timeline, lineage | `lib/session-reader.ts` |
| Browser run state, reconnect, branch navigation | `hooks/useAgentSession.ts` |
| Streaming assembly / tool-call adaptation | `lib/streaming-message.ts`, `lib/normalize.ts` |
| Tool selection | `lib/tool-presets.ts` |
| Project identity (session cwd) | `lib/session-reader.ts`, `components/SessionSidebar.tsx` |
| Project trust | `lib/project-trust.ts`, `lib/rpc-manager.ts` |
| File/resource authorization | `lib/agent/files-service.ts`, `lib/file-access.ts`, `lib/path-security.ts` |
| Browser resources / tickets | `lib/resource-client.ts`, `hooks/useResourceUrl.ts`, `lib/agent/resource-ticket.ts` |
| Referenced external files | `lib/session-file-references.ts` |
| Default workspace | `lib/default-workspace.ts` |
| Shared file drafts | `components/AppShell.tsx`, `lib/draft-store.ts`, `lib/file-draft.ts` |
| Desktop owned Service / identity | `electron/main.mjs`, `electron/local-service.mjs` |
| System Node / bundled search tools | `electron/system-node.mjs`, `electron/runtime.mjs`, `electron/toolsets.mjs` |
| Production artifact closure | `electron/service-build.mjs`, `electron/build.mjs`, `electron/builder.json` |
| Static Desktop UI protocol | `electron/protocol.mjs`, `desktop/main.tsx`, `desktop/index.html` |
| Desktop Service connection bridge | `electron/preload.cjs`, `electron/main.mjs` (`agent-service:config`) |
| Dev supervisor (Service + UI/Electron) | `electron/dev-service-ui.mjs`, `electron/dev.mjs` |
| Service ownership (one writer per profile) | `lib/agent/service/ownership.ts`, `lib/agent/service/entry.ts` |
| Update admission (owned Service gate) | `lib/agent/service/maintenance-control.ts`, `electron/service-control.mjs` |
| Desktop updates / releases | `electron/updates.mjs`, `electron/update-install.mjs`, `docs/desktop-distribution-plan.md` |
| Production Web host (managed / attach) | `bin/web-host.mjs`, `bin/weclio-web.js` |
| Browser connection bootstrap | `lib/local-web-connection.ts` |
| UI-only build admission | `bin/ui-build.js` |

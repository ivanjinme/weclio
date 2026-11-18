
## System Architecture


```text

    Desktop (Electron + React)           Web (React)
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
  Scale  → Multiple isolated runtime environments,
           each with its own Agent Service
```

- Desktop loads a Vite static build through the `weclio://app` protocol and talks HTTP/SSE to the Service directly; it has no UI server process and no loopback HTTP page trust.
- AgentRuntime is explicitly owned by the Service host, not a Next/HMR singleton. UI requires an explicitly selected Service; the Desktop host supplies that selection through a restricted IPC bridge.
- Pi owns agent execution, session persistence/tree semantics, and model-context construction. Do not reimplement them.

## 不变量

- Service 只运行在标准 Node.js 上：代码、构建、部署都不依赖 Electron/Next API、安装路径或自带 Runtime。
- 宿主可以启停 Service，Service 不依赖宿主；同一产物能独立运行。
- 每个规范化 Pi profile 与 state 目录只有一个写者，由 OS 互斥在初始化内置包之前取得；其他客户端只通过 HTTP 连接，不共享运行时。
- 所有改变状态的请求走同一个准入闸门；维护期间只读仍可用。
- 退出顺序：渲染器否决优先 → 窗口接受关闭 → 加锁 → 确认 Service 退出 → 交给安装器。
- UI 不猜后端：连接显式、运行时注入、不写进产物，不回退 `/api` 或同源。
- 协议版本是兼容契约，UI 挂载前必须校验。
- 被测产物就是发布产物：验收针对安装后的 tarball/安装器，而不是源码树。

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

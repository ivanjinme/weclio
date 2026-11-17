
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
| Bundled Node/npm / tools | `electron/node-runtime.mjs`, `electron/runtime.mjs`, `electron/toolsets.mjs` |
| Production artifact closure | `electron/service-build.mjs`, `electron/build.mjs`, `electron/builder.json` |
| Static Desktop UI protocol | `electron/protocol.mjs`, `desktop/main.tsx`, `desktop/index.html` |
| Desktop Service connection bridge | `electron/preload.cjs`, `electron/main.mjs` (`agent-service:config`) |
| Dev supervisor (Service + UI/Electron) | `electron/dev-service-ui.mjs`, `electron/dev.mjs` |
| Update admission (owned Service gate) | `lib/agent/service/maintenance-control.ts`, `electron/service-control.mjs` |
| Desktop updates / releases | `electron/updates.mjs`, `electron/update-install.mjs`, `docs/desktop-distribution-plan.md` |
| UI-only build admission | `bin/ui-build.js`, `bin/weclio-web.js` |

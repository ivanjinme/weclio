
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

Deployment:
  Local  → Agent Service on user's machine
  Remote → Dedicated VM / container / sandbox per user
  Scale  → Multiple isolated runtime environments,
           each with its own Agent Service
```

- Shared services have no Next.js/Electron dependencies.
- Hosts own transport and lifecycle; shared services own business logic.
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
| Desktop processes / bundled tools | `electron/main.mjs`, `electron/toolsets.mjs` |
| Desktop updates / releases | `electron/updates.mjs`, `docs/desktop-release.md` |

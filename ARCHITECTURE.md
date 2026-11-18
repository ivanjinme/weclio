
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

## Invariants

- The Service runs on standard Node.js only: no Electron/Next API, installer path, or bundled runtime in its code, build or deployment.
- A host may start and stop the Service; the Service never depends on the host. The same artifact runs standalone.
- One writer per canonical Pi profile and state directory, held by an OS mutex taken before package seeding. Extra clients attach over HTTP and never share the runtime.
- Every state-changing route passes one admission gate; reads stay available during maintenance.
- Quit order: renderer veto wins → close accepted → lock → Service exit confirmed → installer handoff.
- The UI never guesses a backend: the connection is explicit, injected at runtime, never baked into assets, never falling back to `/api` or same-origin.
- Protocol version is the compatibility contract and is verified before the UI mounts.
- The tested artifact is the shipped artifact: acceptance runs against the installed tarball/installer, not the source tree.

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

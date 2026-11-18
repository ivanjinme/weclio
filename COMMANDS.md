# Commands

## Development

```bash
npm run dev          # Desktop, loads weclio://app (alias: dev:desktop)
npm run dev:web      # Web: Service + Next UI on :8888
```

## Local production Web

```bash
npm run build:web-service   # Prepare the standard-Node Service artifact
npm run build               # Build the Next UI (use isolated staging for verification)
npm start                   # Start the UI and its own loopback Service
```

The packaged `npx @weclio/web` starts both processes. `npx @weclio/web service` starts only the Service.

```bash
npx @weclio/web --service-url http://127.0.0.1:<port> --token-file <absolute-token-file>
```

Attaches the UI to an already running Service instead of starting one. The Service must allow the UI origin
(`http://127.0.0.1:8888` by default); attach never starts, stops or takes over that Service.
Only one Weclio Service may write a given Pi profile at a time.

## Checks

```bash
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```
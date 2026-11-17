# Commands

## Development

```bash
npm run dev          # Desktop, loads weclio://app (alias: dev:desktop)
npm run dev:web      # Web: Service + Next UI on :8888
```

## Checks

```bash
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```
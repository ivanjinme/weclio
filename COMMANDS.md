# Commands

Repo root · Bash / Git Bash · stop on failure.

## Development

```bash
npm run dev           # Desktop (default)
npm run dev:desktop   # Desktop
npm run dev:web       # Web
npm run dev:service-ui # 浏览器验证：独立 Agent Service（系统 Node）+ 指向它的 Next UI
```

`dev:service-ui` 只是一个开发用的接线脚本；Service 与 UI 同机不同端口，令牌由脚本从
Service 的 stateDir 读出后注入 UI 进程。共享 `~/.pi/agent`（会话与凭据）；若需隔离，
启动前设 `WECLIO_DEV_AGENT_DIR=<绝对路径>`。

## Checks

```bash
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

跑全量测试要限制并发，否则 4 个拉起子进程的用例会超时：

```bash
node --test --test-concurrency=4 lib/*.test.mjs ...
```

## Publish Web UI (npm)

Committed source · clean worktree · `v*` triggers npm workflow.

```bash
set -e
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
```

## Publish Desktop

Windows x64 · committed source · clean worktree · signing configured · `gh` authenticated.

```bash
set -e
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
TAG="desktop-v$VERSION"
git add package.json package-lock.json
git commit -m "Release desktop $VERSION"
COMMIT=$(git rev-parse HEAD)
npm run release:desktop
(cd build/desktop/dist && sha256sum -c SHA256SUMS.txt)
git push origin main

gh release create "$TAG" --repo ivanjinme/weclio --draft --target "$COMMIT" \
  --title "Weclio desktop $VERSION" --notes "Desktop app update." \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe" \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe.blockmap" \
  "build/desktop/dist/desktop-update-manifest.json" \
  "build/desktop/dist/SHA256SUMS.txt"

# Verify draft assets, signature, version, source before publishing
gh release edit "$TAG" --repo ivanjinme/weclio --draft=false --latest
```

No `next build` in dev directory. No `npm run release`. No asset wildcards / `--clobber`.

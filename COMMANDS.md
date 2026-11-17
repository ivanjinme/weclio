# Commands

Repo root · Bash / Git Bash · stop on failure.

## Development

```bash
npm run dev            # 默认：独立 Service + Next UI + Electron
npm run dev:desktop    # 同上
npm run dev:web        # 独立 Service（系统 Node）+ Next UI，浏览器访问
npm run dev:service-ui # 与 dev:web 相同的诊断入口
```

Desktop/Web 开发入口共用启动器，默认 UI8888 / Service8899；可用 `WECLIO_DEV_UI_PORT` /
`WECLIO_DEV_SERVICE_PORT` 覆盖（Desktop 仍兼容 `PORT`）。先检查端口，再等 Service READY/token，
最后启动 UI；Electron 还需等待本次 UI ready + HTTP。退出只清理自有进程树，不接管已有端口。

令牌从 Service 的 stateDir 读取后作为本地开发引导注入 UI 内存；不是成品 Web 认证方案。
默认共享 `~/.pi/agent`（会话与凭据）；隔离测试设置 `WECLIO_DEV_AGENT_DIR=<绝对路径>`，
另配 `WECLIO_AGENT_STATE_DIR` / `WECLIO_AGENT_WORKSPACE`。Next dev 输出独立存放，不删除普通 `.next`。

`dev:lan` 仅启动 UI，不启动或公开 Agent；必须显式配置所选 Service 与来源策略。未配置时只显示提示。
`start` / `start:lan` / `weclio-web` 仅服务已构建 UI，不启动 Agent，并拒绝含旧业务路由或 instrumentation 的编译产物。
当前 P2 中间态尚未重新构建生产 UI/Service/Runtime，不得打包发布。

## Checks

```bash
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

跑全量测试要限制并发，否则 4 个拉起子进程的用例会超时：

```bash
node --test --test-concurrency=4 bin/*.test.mjs lib/*.test.mjs lib/agent/*.test.mjs lib/agent/protocol/*.test.mjs lib/agent/service/*.test.mjs hooks/*.test.mjs components/*.test.mjs components/composer/*.test.mjs electron/*.test.mjs
```

开发树残留的 `.next` / `build` validator 可能引用已退役的路由，完整 tsc 因此报错时须区分源码和生成物；
不要为通过检查而删除正在运行的 Next 输出。本轮另做排除生成目录的源码检查；干净生产构建验证仍留在后续阶段。

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

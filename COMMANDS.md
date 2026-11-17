# Commands

Repo root · Bash / Git Bash · stop on failure.

## Development

```bash
npm run dev            # 默认：构建静态 UI + 独立 Service + Electron（无 Next 进程）
npm run dev:desktop    # 同上
npm run dev:web        # 独立 Service（系统 Node）+ Next UI，浏览器访问
npm run dev:service-ui # 与 dev:web 相同的诊断入口
```

Desktop 开发入口先构建一次 Vite 静态资产到 `build/desktop-ui`（约 40 秒），再由启动器起
Service、等 READY/token，最后拉起 Electron；窗口加载 `weclio://app/index.html`，不再启动 next dev/start。
只改组件时可手动 `npm run build:desktop-ui` 后重跑 `node electron/dev.mjs` 跳过重复构建。
Service 默认 8899（`WECLIO_DEV_SERVICE_PORT`）；Desktop 不占用 UI 端口，Web 仍默认 UI8888。

Service 就绪后才启动 GUI；Service 退出、Electron 非零退出或 logo 关闭都会清理自有进程树，
不接管已有端口，也不按进程名杀系统 Node。

未预先构建静态资产时，启动器直接失败并提示运行 `npm run build:desktop-ui`，不会隐式降级回 Next。
开发态 Electron 主进程读取 `WECLIO_DESKTOP_AGENT_URL` / `WECLIO_DESKTOP_AGENT_TOKEN_FILE` /
`WECLIO_DESKTOP_UI_DIR`；缺任何一个都在报错后退 1，不会启动后备后端。
安装态则从资源目录启动自有 bundled Node/Service，认证并核对 READY、实例、PID 与协议后才加载静态 UI。
令牌经受限 IPC（`agent-service:config`，仅接受 `weclio://app` 发送方）交给渲染器保存在内存，
不写入静态资产或 URL。

令牌从 Service 的 stateDir 读取后作为本地开发引导注入 UI 内存；不是成品 Web 认证方案。
默认共享 `~/.pi/agent`（会话与凭据）；隔离测试设置 `WECLIO_DEV_AGENT_DIR=<绝对路径>`，
另配 `WECLIO_AGENT_STATE_DIR` / `WECLIO_AGENT_WORKSPACE`。Next dev 输出独立存放，不删除普通 `.next`。

`dev:lan` 仅启动 UI，不启动或公开 Agent；必须显式配置所选 Service 与来源策略。未配置时只显示提示。
`start` / `start:lan` / `weclio-web` 仅服务已构建的 Next UI，不启动 Agent，并拒绝含旧业务路由或 instrumentation 的编译产物。
Desktop 候选资源已接线，旧 `production.mjs` / Next server 启动链已移除；更新交接 P5 与真实安装/升级 P6 尚未完成，
不得把当前分支当作可发布安装包。

## Local Desktop Candidate Build

仅在获准本地构建时执行；不安装系统软件、不构建 NSIS、不签名或上传：

```bash
npm run prepare:desktop-runtime  # 首次获取官方完整 Node ZIP、校验固定摘要，保留 Node/npm/npx/shims/许可证
npm run build:desktop            # build/desktop/{ui,service,host}；不会写 dev UI 或 .next
WECLIO_SERVICE_ARTIFACT="$PWD/build/desktop/service" WECLIO_NODE_RUNTIME="$PWD/resources/runtime/win-x64/node" \\
  node --test --test-concurrency=4 electron/service-artifact.integration.test.mjs
```

Runtime 固定版本与摘要在 `electron/node-runtime.mjs`；本机缓存和资源二进制不进 Git。
Service/Host 依赖分别按实际运行时引用和根锁校验闭包，保留 SDK 动态加载器、TS 扩展、WASM、模板与许可证。
产物测试移到仓库外、隔离 HOME、不依赖仓库源码/根 node_modules，使用本机模型 fixture，不发送真实 provider 提示。
普通全量测试默认跳过这项耗时产物测试；`release:desktop` 在完整构建及 quick 复用路径上均显式执行，不可跳过。

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

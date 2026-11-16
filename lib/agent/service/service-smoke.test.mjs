import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti");

async function writeBootstrap(root) {
  const entry = join(repoRoot, "lib", "agent", "service", "entry.ts");
  const path = join(root, "bootstrap.mjs");
  await writeFile(path, `import { createJiti } from ${JSON.stringify(pathToFileURL(jitiPath).href)};
const jiti = createJiti(import.meta.url);
const entry = await jiti.import(${JSON.stringify(pathToFileURL(entry).href)});
await entry.main();
`);
  return path;
}

async function spawnService(root, bootstrap, env) {
  const child = spawn(process.execPath, [bootstrap], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`service did not become ready\nstdout: ${stdout}\nstderr: ${stderr}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("WECLIO_AGENT_READY "));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line.slice("WECLIO_AGENT_READY ".length)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`service exited before ready (${code})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

async function serviceEnv(root) {
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key)),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TEMP: root,
    TMP: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    WECLIO_AGENT_STATE_DIR: join(root, "state"),
    WECLIO_AGENT_WORKSPACE: join(root, "workspace"),
    WECLIO_AGENT_PORT: "0",
    WECLIO_AGENT_DRAIN_TIMEOUT_MS: "5000",
    WECLIO_AGENT_VERSION: "0.0.0-test",
    WECLIO_AGENT_ALLOWED_ORIGINS: "weclio://app",
    NODE_ENV: "test",
  });
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(root, "workspace"), { recursive: true }),
  ]);
  return { env, agentDir, workspace: join(root, "workspace"), stateDir: join(root, "state") };
}

async function call(url, path, { token, method = "GET", body, raw, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined && raw === undefined ? {} : { "Content-Type": raw === undefined ? "application/json" : "text/plain" }),
      ...headers,
    },
    ...(body === undefined && raw === undefined ? {} : { body: raw === undefined ? JSON.stringify(body) : raw }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

// 绝对路径 → /v1/files/<segments>。
function filePathUrl(target, type, search = "") {
  const segments = target.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `/v1/files/${encoded}?type=${type}${search}`;
}

test("independent service: auth, info, real tool execution, single writer, graceful shutdown", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-agent-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { env, agentDir, workspace, stateDir } = await serviceEnv(root);
  const bootstrap = await writeBootstrap(root);
  const service = await spawnService(root, bootstrap, env);
  t.after(async () => { if (service.child.exitCode === null) service.child.kill(); await service.exited.catch(() => {}); });

  const { url, serviceId } = await service.ready;
  assert.equal(url.startsWith("http://127.0.0.1:"), true);
  const token = (await readFile(join(stateDir, "service-token"), "utf8")).trim();
  assert.ok(token.length >= 32);

  const health = await call(url, "/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok" });
  assert.equal(health.headers.get("x-request-id")?.length, 36);

  const anonymous = await call(url, "/v1/info");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, "unauthorized");

  // 先授权默认工作区：会话被删除后 roots 仍来自持久授权，而不是仅靠会话 cwd。
  const authorize = await call(url, "/v1/workspaces/default", { token, method: "POST" });
  assert.deepEqual(authorize.body, { cwd: workspace });

  const info = await call(url, "/v1/info", { token });
  assert.equal(info.status, 200);
  assert.equal(info.body.serviceId, serviceId);
  assert.equal(info.body.protocol.version, 1);
  assert.equal(info.body.app.version, "0.0.0-test");
  assert.deepEqual(info.body.capabilities, ["commands"]);

  // 静态 UI 的来源需要显式放行；未知来源仍然 403。
  const appOrigin = await call(url, "/v1/info", { token, headers: { Origin: "weclio://app" } });
  assert.equal(appOrigin.status, 200);

  const crossOrigin = await call(url, "/v1/info", { token, headers: { Origin: "http://evil.example" } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, "forbidden_origin");

  const unknown = await call(url, "/v1/sessions/smoke/commands", { token, method: "POST", body: { type: "get_tool" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "invalid_command");

  const missing = await call(url, "/v1/nope", { token });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "not_found");

  const shell = await call(url, `/v1/sessions/smoke/commands?cwd=${encodeURIComponent(workspace)}`, {
    token,
    method: "POST",
    body: { type: "bash", command: "printf service-smoke; printf file-content > probe.txt" },
  });
  assert.equal(shell.status, 200, JSON.stringify(shell.body));
  assert.equal(shell.body.success, true);
  assert.equal(shell.body.data.output, "service-smoke");
  assert.equal(shell.body.data.exitCode, 0);

  // shell 在工作区真实执行；会话与结果落到该 Service 自己的 agentDir。
  assert.equal(await readFile(join(workspace, "probe.txt"), "utf8"), "file-content");
  const sessionFiles = await readdir(join(agentDir, "sessions"), { recursive: true });
  assert.ok(sessionFiles.some((entry) => entry.endsWith(".jsonl")), "session transcript must be persisted");

  // 会话查询与 mutation 与 Next 共用同一实现，这里验证 Service 侧行为。
  const catalog = await call(url, "/v1/sessions", { token });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.sessions.length, 1);
  const sessionId = catalog.body.sessions[0].id;

  const titles = await call(url, "/v1/sessions/titles", { token, method: "POST", body: { ids: [sessionId] } });
  assert.equal(titles.status, 200);
  assert.equal(titles.body.titles[0].id, sessionId);

  const view = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}?deferThinking`, { token });
  assert.equal(view.status, 200);
  assert.equal(view.body.info.id, sessionId);
  assert.ok(view.body.info.messageCount >= 1);
  assert.ok(Array.isArray(view.body.tree));

  const state = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}/state`, { token });
  assert.equal(state.status, 200);
  assert.equal(state.body.running, true);
  assert.equal(state.body.state.sessionId, sessionId);

  const renamed = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
    token, method: "PATCH", body: { name: "Smoke session" },
  });
  assert.equal(renamed.status, 200);
  const renamedView = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}`, { token });
  assert.equal(renamedView.body.info.name, "Smoke session");

  const deleted = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}`, { token, method: "DELETE" });
  assert.equal(deleted.status, 200);
  const gone = await call(url, `/v1/sessions/${encodeURIComponent(sessionId)}`, { token });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, "session_not_found");

  // 工作区、项目信任与置顶同样走共享实现。
  const home = await call(url, "/v1/home", { token });
  assert.equal(home.status, 200);
  assert.equal(home.body.home, env.HOME);

  const defaultWorkspace = await call(url, "/v1/workspaces/default", { token });
  assert.deepEqual(defaultWorkspace.body, { cwd: workspace });
  const created = await call(url, "/v1/workspaces/default", { token, method: "POST" });
  assert.deepEqual(created.body, { cwd: workspace });

  const validated = await call(url, "/v1/workspaces/validate", { token, method: "POST", body: { cwd: workspace } });
  assert.deepEqual(validated.body, { success: true, cwd: workspace });
  const missingWorkspace = await call(url, "/v1/workspaces/validate", {
    token, method: "POST", body: { cwd: join(workspace, "missing") },
  });
  assert.equal(missingWorkspace.status, 400);
  assert.equal(missingWorkspace.body.error.code, "invalid_argument");

  const browse = await call(url, `/v1/workspaces/browse?path=${encodeURIComponent(workspace)}`, { token });
  assert.equal(browse.status, 200);
  assert.ok(Array.isArray(browse.body.directories));

  const write = await call(url, filePathUrl(join(workspace, "probe.txt"), "read"), {
    token, method: "PUT", raw: "updated-content",
  });
  assert.equal(write.status, 200);
  assert.equal(write.body.size, "updated-content".length);
  const read = await call(url, filePathUrl(join(workspace, "probe.txt"), "read"), { token });
  assert.equal(read.body.content, "updated-content");
  assert.equal(read.body.language, "text");
  assert.equal(read.body.editable, true);
  const meta = await call(url, filePathUrl(join(workspace, "probe.txt"), "meta"), { token });
  assert.equal(meta.body.size, "updated-content".length);
  assert.equal(typeof meta.body.mime, "string");
  const listing = await call(url, filePathUrl(workspace, "list"), { token });
  assert.ok(listing.body.entries.some((entry) => entry.name === "probe.txt"));
  assert.equal(listing.body.path, workspace.replaceAll("\\", "/"));

  const ranged = await fetch(`${url}${filePathUrl(join(workspace, "probe.txt"), "download")}`, {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-6" },
  });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "updated");
  assert.ok((ranged.headers.get("content-range") ?? "").startsWith("bytes 0-6/"));

  const watchAbort = new AbortController();
  const watching = await fetch(`${url}${filePathUrl(join(workspace, "probe.txt"), "watch")}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: watchAbort.signal,
  });
  const firstChunk = await watching.body.getReader().read();
  watchAbort.abort();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: connected/);

  // multipart 上传：新增、冲突拒绝、跳过与预检。
  const uploadUrl = filePathUrl(workspace, "upload");
  const upload = async (conflict, name, content) => {
    const form = new FormData();
    form.append("files", new Blob([content]), name);
    const response = await fetch(`${url}${uploadUrl}&conflict=${conflict}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, body: await response.json() };
  };

  const uploadedOnce = await upload("error", "uploaded.txt", "upload-body");
  assert.equal(uploadedOnce.status, 200);
  assert.deepEqual(uploadedOnce.body.uploaded, ["uploaded.txt"]);
  assert.equal(await readFile(join(workspace, "uploaded.txt"), "utf8"), "upload-body");

  const conflicted = await upload("error", "uploaded.txt", "second");
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.body.error.code, "conflict");
  assert.deepEqual(conflicted.body.error.conflicts, ["uploaded.txt"]);

  const skippedUpload = await upload("skip", "uploaded.txt", "second");
  assert.equal(skippedUpload.status, 200);
  assert.deepEqual(skippedUpload.body.skipped, ["uploaded.txt"]);
  assert.equal(await readFile(join(workspace, "uploaded.txt"), "utf8"), "upload-body");

  const overwritten = await upload("overwrite", "uploaded.txt", "replaced");
  assert.deepEqual(overwritten.body.uploaded, ["uploaded.txt"]);
  assert.equal(await readFile(join(workspace, "uploaded.txt"), "utf8"), "replaced");

  const check = await call(url, filePathUrl(workspace, "upload-check"), {
    token, method: "POST", body: { fileNames: ["uploaded.txt", "fresh.txt"] },
  });
  assert.deepEqual(check.body, { conflicts: ["uploaded.txt"], nonReplaceable: [] });

  const badName = await upload("error", "../escape.txt", "x");
  assert.equal(badName.status, 400);
  assert.equal(badName.body.error.code, "invalid_argument");

  const badType = await call(url, filePathUrl(join(workspace, "probe.txt"), "explode"), { token });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, "invalid_argument");

  const index = await call(url, `/v1/files/index?cwd=${encodeURIComponent(workspace)}`, { token });
  assert.equal(index.status, 200);
  assert.ok(index.body.files.includes("probe.txt"));
  const search = await call(url, `/v1/files/index?cwd=${encodeURIComponent(workspace)}&q=probe`, { token });
  assert.ok(search.body.matches.some((match) => match.path === "probe.txt"));

  const git = await call(url, `/v1/git/status?cwd=${encodeURIComponent(workspace)}`, { token });
  assert.equal(git.status, 200);
  assert.equal(git.body.isGitRepository, false);
  const diff = await call(url, `/v1/git/diff?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, "probe.txt"))}`, { token });
  assert.deepEqual(diff.body, { supported: false });
  const outsideGit = await call(url, `/v1/git/status?cwd=${encodeURIComponent(join(root, "elsewhere"))}`, { token });
  assert.equal(outsideGit.status, 403);
  assert.equal(outsideGit.body.error.code, "forbidden");

  // 显式放入需要信任的项目资源，避免结论依赖测试机的祖先目录。
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(join(workspace, ".pi", "extensions", "probe.js"), "export default () => {};");
  const trust = await call(url, `/v1/projects/trust?cwd=${encodeURIComponent(workspace)}`, { token });
  assert.equal(trust.status, 200);
  assert.deepEqual(trust.body, { requiresTrust: true, trusted: false });
  const trusted = await call(url, "/v1/projects/trust", { token, method: "POST", body: { cwd: workspace } });
  assert.equal(trusted.status, 200);
  assert.deepEqual(trusted.body, { requiresTrust: true, trusted: true });
  const trustAgain = await call(url, `/v1/projects/trust?cwd=${encodeURIComponent(workspace)}`, { token });
  assert.deepEqual(trustAgain.body, { requiresTrust: true, trusted: true });

  const emptyPins = await call(url, "/v1/settings/pins", { token });
  assert.deepEqual(emptyPins.body, { pins: [] });
  const pinned = await call(url, "/v1/settings/pins", {
    token, method: "PATCH", body: { type: "project", id: workspace, pinned: true },
  });
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.body.pins, [{ type: "project", id: workspace }]);

  // 模型配置与默认模型：写入后立即可读，列表与测试走同一实现。
  const modelsConfig = {
    providers: {
      "smoke-provider": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/never-called",
        apiKey: "fixture-only-not-a-credential",
        models: [{ id: "smoke-model", name: "Smoke Model", input: ["text"], contextWindow: 4096, maxTokens: 256 }],
      },
    },
  };
  const putConfig = await call(url, "/v1/settings/models", { token, method: "PUT", body: modelsConfig });
  assert.deepEqual(putConfig.body, { success: true });
  const configBack = await call(url, "/v1/settings/models", { token });
  assert.deepEqual(configBack.body, modelsConfig);

  const models = await call(url, "/v1/models", { token });
  assert.equal(models.status, 200);
  assert.ok(models.body.modelList.some((model) => model.provider === "smoke-provider" && model.id === "smoke-model"));
  const missingCwd = await call(url, `/v1/models?cwd=${encodeURIComponent(join(root, "missing"))}`, { token });
  assert.equal(missingCwd.status, 400);
  assert.equal(missingCwd.body.error.code, "invalid_argument");

  const setDefault = await call(url, "/v1/settings/models/default", {
    token, method: "PUT", body: { provider: "smoke-provider", modelId: "smoke-model" },
  });
  assert.deepEqual(setDefault.body, { success: true });
  const settingsJson = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal(settingsJson.defaultProvider, "smoke-provider");
  assert.equal(settingsJson.defaultModel, "smoke-model");

  const testModel = await call(url, "/v1/settings/models/test", {
    token,
    method: "POST",
    body: {
      providerName: "smoke-provider",
      provider: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-called" },
      model: { id: "smoke-model" },
    },
  });
  assert.equal(testModel.body.ok, false);
  assert.match(testModel.body.error, /No API key/);

  // Provider 凭据：只暴露状态，不回传密钥。
  const oauthProviders = await call(url, "/v1/provider-auth/oauth", { token });
  assert.equal(oauthProviders.status, 200);
  assert.ok(Array.isArray(oauthProviders.body.providers));
  assert.equal(oauthProviders.body.providers.some((provider) => provider.id === "anthropic"), false);

  const keyProviders = await call(url, "/v1/provider-auth/providers", { token });
  assert.equal(keyProviders.status, 200);
  assert.ok(Array.isArray(keyProviders.body.providers));

  const keyStatus = await call(url, "/v1/provider-auth/api-key/openai", { token });
  assert.equal(keyStatus.status, 200);
  assert.equal(typeof keyStatus.body.configured, "boolean");
  assert.equal(JSON.stringify(keyStatus.body).includes("sk-"), false);

  const badKey = await call(url, "/v1/provider-auth/api-key/openai", { token, method: "POST", body: { apiKey: "  " } });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.body.error.code, "invalid_argument");

  const badLogout = await call(url, "/v1/provider-auth/logout/cerebras", { token, method: "POST", body: {} });
  assert.equal(badLogout.status, 400);
  assert.equal(badLogout.body.error.code, "invalid_argument");

  const usage = await call(url, "/v1/usage/codex", { token });
  assert.equal(usage.status, 200);

  // 会话事件流：先 connected，再按 seq 单调推进；断开不取消 Agent。
  const streamAbort = new AbortController();
  const streamResponse = await fetch(`${url}/v1/sessions/stream-smoke/events?cwd=${encodeURIComponent(workspace)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: streamAbort.signal,
  });
  assert.equal(streamResponse.status, 200);
  assert.ok((streamResponse.headers.get("content-type") ?? "").startsWith("text/event-stream"));
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readUntil = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!predicate(buffer)) {
      assert.ok(Date.now() < deadline, `timed out; got: ${buffer}`);
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return buffer;
  };
  await readUntil((text) => text.includes("event:") || text.includes("data:"));
  assert.match(buffer, /"type":"connected"/);
  assert.match(buffer, /"resync":false/);
  assert.match(buffer, /"seq":1/);
  streamAbort.abort();

  // 重连带 Last-Event-ID 时明确要求 resync。
  const resyncAbort = new AbortController();
  const resync = await fetch(`${url}/v1/sessions/stream-smoke/events?cwd=${encodeURIComponent(workspace)}`, {
    headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": "3" },
    signal: resyncAbort.signal,
  });
  const resyncChunk = await resync.body.getReader().read();
  resyncAbort.abort();
  assert.match(new TextDecoder().decode(resyncChunk.value), /"resync":true/);

  const anonymousStream = await fetch(`${url}/v1/sessions/stream-smoke/events`);
  assert.equal(anonymousStream.status, 401);

  // OAuth 登录：Provider 无 oauth flow 时立即报错并结束流；手动回调需 token+code。
  const loginResponse = await fetch(`${url}/v1/provider-auth/login/cerebras`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.text();
  assert.ok(loginBody.includes(String.fromCharCode(34) + "type" + String.fromCharCode(34) + ":" + String.fromCharCode(34) + "error" + String.fromCharCode(34)));
  assert.match(loginBody, /Unknown provider/);

  const badCallback = await call(url, "/v1/provider-auth/login/cerebras", { token, method: "POST", body: { token: "x" } });
  assert.equal(badCallback.status, 400);
  assert.equal(badCallback.body.error.code, "invalid_argument");

  const unknownCallback = await call(url, "/v1/provider-auth/login/cerebras", {
    token, method: "POST", body: { token: "cerebras-unknown", code: "abc" },
  });
  assert.equal(unknownCallback.status, 404);
  assert.equal(unknownCallback.body.error.code, "not_found");

  const anonymousLogin = await fetch(`${url}/v1/provider-auth/login/cerebras`);
  assert.equal(anonymousLogin.status, 401);

  // 资源包：列举与参数校验走共享实现。
  const globalPlugins = await call(url, "/v1/plugins?global=true", { token });
  assert.equal(globalPlugins.status, 200);
  assert.ok(Array.isArray(globalPlugins.body.packages));
  assert.equal(globalPlugins.body.projectResourcesLoaded, false);

  const missingCwdPlugins = await call(url, "/v1/plugins", { token });
  assert.equal(missingCwdPlugins.status, 400);
  assert.equal(missingCwdPlugins.body.error.code, "invalid_argument");

  const projectPlugins = await call(url, `/v1/plugins?cwd=${encodeURIComponent(workspace)}`, { token });
  assert.equal(projectPlugins.status, 200);

  const badAction = await call(url, "/v1/plugins", { token, method: "POST", body: { action: "explode" } });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error.code, "invalid_argument");

  // Skills：列举与参数校验；安装/更新在未授权时被拒且不启动子进程。
  const globalSkills = await call(url, "/v1/skills?global=true", { token });
  assert.equal(globalSkills.status, 200);
  assert.ok(Array.isArray(globalSkills.body.skills));

  const missingCwdSkills = await call(url, "/v1/skills", { token });
  assert.equal(missingCwdSkills.status, 400);

  const badSearch = await call(url, "/v1/skills/search", { token, method: "POST", body: {} });
  assert.equal(badSearch.status, 400);
  assert.equal(badSearch.body.error.code, "invalid_argument");

  const badUpdate = await call(url, "/v1/skills/update", { token, method: "POST", body: { package: "p" } });
  assert.equal(badUpdate.status, 400);

  const deniedInstall = await call(url, "/v1/skills/install", {
    token, method: "POST", body: { package: "p", scope: "project", cwd: join(root, "outside") },
  });
  assert.equal(deniedInstall.status, 403);
  assert.equal(deniedInstall.body.error.code, "forbidden");

  const malformed = await fetch(`${url}/v1/sessions/smoke/commands?cwd=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_argument");

  // 第二个进程不得成为同一状态目录的写入者。
  await assert.rejects(
    promisify(execFile)(process.execPath, [bootstrap], { cwd: root, env, timeout: 20_000, windowsHide: true }),
    (error) => {
      assert.match(String(error.stderr), /already owns/);
      return true;
    },
  );

  service.child.stdin.write("shutdown\n");
  assert.equal(await service.exited, 0);
  const { stdout } = service.output();
  assert.match(stdout, /WECLIO_AGENT_CLOSED .*"timedOut":false/);
  assert.equal(existsSync(join(stateDir, "owner.json")), false);
});

test("service module graph stays free of Next, Electron and React", async () => {
  // "@/" 别名只能在 Next 里解析；Service 图必须全部使用相对路径。
  const forbidden = /^(next|electron|react|react-dom)(\/|$)|^@\//;
  const entry = join(repoRoot, "lib", "agent", "service", "entry.ts");
  const seen = new Set();
  const offenders = [];

  async function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (forbidden.test(specifier)) offenders.push(`${file} -> ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const candidate = target.endsWith(".ts") ? target : `${target}.ts`;
      if (existsSync(candidate)) await walk(candidate);
    }
  }

  await walk(entry);
  assert.deepEqual(offenders, []);
  assert.ok(seen.size > 5, "graph walk should cover the service and its runtime modules");
});

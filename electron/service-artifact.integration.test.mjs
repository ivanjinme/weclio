import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createServiceRuntimeEnvironment } from "./runtime.mjs";

const artifact = process.env.WECLIO_SERVICE_ARTIFACT;
const node = process.execPath;
const wait = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

test("production closure outside the repository runs a real tool loop and TS extension with system Node", {
  skip: !artifact, timeout: 150_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio P4 中文-"));
  let child;
  let model;
  let exited;
  let stdout = "";
  let stderr = "";
  t.after(async () => {
    try {
      if (child?.pid && child.exitCode === null) {
        child.stdin.write("shutdown\n");
        await Promise.race([exited, wait(8000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }
    } finally {
      t.diagnostic(`Service output: ${stdout.slice(-5000)}\n${stderr.slice(-5000)}`);
      if (model?.listening) { model.closeAllConnections(); await new Promise((resolve_) => model.close(resolve_)); }
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  const serviceDir = join(root, "service");
  const nodeDir = dirname(node);
  const agentDir = join(root, "home/.pi/agent");
  const workspace = join(root, "workspace");
  await Promise.all([cp(resolve(artifact), serviceDir, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(workspace)]);
  let requests = 0;
  let probeCalls = 0;
  const operations = [
    ["write", { path: "artifact.txt", content: "FIRST\n" }],
    ["edit", { path: "artifact.txt", oldText: "FIRST", newText: "SECOND" }],
    ["read", { path: "artifact.txt" }],
    ["p4_probe", {}],
  ];
  model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.ok(body.tools?.some((tool) => tool.function?.name === "p4_probe"), "TS extension tool must reach model context");
    const index = requests++;
    if (index > 8) { res.writeHead(500).end("too many fixture requests"); return; }
    const operation = operations[index];
    if (operation?.[0] === "p4_probe") probeCalls++;
    const delta = operation
      ? { tool_calls: [{ index: 0, id: `fixture-${index}`, type: "function", function: { name: operation[0], arguments: JSON.stringify(operation[1]) } }] }
      : { content: "P4_ARTIFACT_LOOP_OK" };
    const chunk = (value, finish_reason = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", ...delta }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, operation ? "tool_calls" : "stop"))}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve_) => model.listen(0, "127.0.0.1", resolve_));
  const provider = { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture-only", models: [{ id: "fixture", name: "P4 fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 1024 }] };
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "p4-fixture": provider } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "p4-fixture", defaultModel: "fixture", enabledModels: ["p4-fixture/fixture"], packages: [], retry: { enabled: false }, compaction: { enabled: false } }));
  const extension = join(agentDir, "extensions/p4");
  await mkdir(join(extension, "node_modules/p4-extra"), { recursive: true });
  await writeFile(join(extension, "node_modules/p4-extra/package.json"), JSON.stringify({ name: "p4-extra", version: "1.0.0", type: "module", main: "index.js" }));
  await writeFile(join(extension, "node_modules/p4-extra/index.js"), 'export const probe = () => "P4_EXTRA_DEPENDENCY_OK";');
  await writeFile(join(extension, "index.ts"), `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport { probe } from "p4-extra";\nexport default (pi: ExtensionAPI) => { pi.registerTool({ name: "p4_probe", label: "P4 probe", description: "Offline production closure probe", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: probe() }], details: {} }; } }); };`);
  const home = join(root, "home");
  const env = createServiceRuntimeEnvironment(nodeDir, join(root, "tools"), {
    PATH: process.platform === "win32" ? join(process.env.SystemRoot, "System32") : "/usr/bin:/bin", SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    TEMP: root, TMP: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    WECLIO_AGENT_STATE_DIR: join(root, "state"), WECLIO_AGENT_WORKSPACE: workspace, WECLIO_AGENT_PORT: "0", WECLIO_AGENT_DRAIN_TIMEOUT_MS: "3000",
  });
  child = spawn(node, [join(serviceDir, "entry.mjs")], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  exited = new Promise((resolve_) => child.once("exit", resolve_));
  const deadline = Date.now() + 45000;
  while (!stdout.includes("WECLIO_AGENT_READY ")) {
    assert.ok(child.exitCode === null && Date.now() < deadline, `Artifact startup failed: ${stdout}\n${stderr}`);
    await wait(100);
  }
  const ready = JSON.parse(stdout.split(/\r?\n/).find((line) => line.startsWith("WECLIO_AGENT_READY ")).slice("WECLIO_AGENT_READY ".length));
  const token = (await readFile(join(root, "state/service-token"), "utf8")).trim();
  async function call(path, body) {
    const response = await fetch(ready.url + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }).catch((error) => {
      throw new Error(`Artifact request failed at ${path}: ${error.message}\n${stdout.slice(-5000)}\n${stderr.slice(-5000)}`, { cause: error });
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  const created = await call("/v1/sessions", { cwd: workspace, type: "ensure_session" });
  const id = created.sessionId;
  assert.ok(id, JSON.stringify(created));
  await call(`/v1/sessions/${id}/commands`, { type: "set_tools", toolNames: ["read", "write", "edit", "p4_probe"] });
  await call(`/v1/sessions/${id}/commands`, { type: "prompt", message: "Run the local artifact tool-loop fixture." });
  let view;
  const promptDeadline = Date.now() + 45000;
  while (Date.now() < promptDeadline) {
    view = await call(`/v1/sessions/${id}`);
    if (JSON.stringify(view).includes("P4_ARTIFACT_LOOP_OK")) break;
    await wait(200);
  }
  assert.match(JSON.stringify(view), /P4_ARTIFACT_LOOP_OK/, stderr);
  assert.equal(await readFile(join(workspace, "artifact.txt"), "utf8"), "SECOND\n");
  assert.match(JSON.stringify(view), /P4_EXTRA_DEPENDENCY_OK/);
  assert.equal(probeCalls, 1);
  await call(`/v1/sessions/${id}/commands`, { type: "reload" });
  const toolState = await call(`/v1/sessions/${id}/commands`, { type: "get_tools" });
  assert.match(JSON.stringify(toolState), /p4_probe/, "TS extension must reload through the production loader");
  const receipt = JSON.parse(await readFile(join(agentDir, "weclio-desktop-packages.json"), "utf8"));
  assert.deepEqual(receipt.initialized, ["@weclio/plugins", "weclio-cli"]);
  // 使用 SDK 自己的 exporter/图片 worker 验证磁盘模板、主题与 WASM，不新增产品 export API。
  const assets = await promisify(execFile)(node, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import {readdir,readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {initTheme,resizeImage} from '@earendil-works/pi-coding-agent';
    initTheme('dark');
    const sessions=join(process.env.PI_CODING_AGENT_DIR,'sessions');
    const name=(await readdir(sessions,{recursive:true})).find(f=>f.includes(${JSON.stringify(id)})&&f.endsWith('.jsonl'));
    assert.ok(name);
    const sdk=import.meta.resolve('@earendil-works/pi-coding-agent');
    const {exportFromFile}=await import(new URL('./core/export-html/index.js',sdk).href);
    const out=${JSON.stringify(join(root, "sdk-export.html"))};
    await exportFromFile(join(sessions,name),out);
    const html=await readFile(out,'utf8');
    const tag='<script id="session-data" type="application/json">';
    assert.ok(html.includes(tag),'SDK export template must contain embedded session data');
    const encoded=html.slice(html.indexOf(tag)+tag.length).split('</script>')[0];
    assert.ok(Buffer.from(encoded,'base64').toString('utf8').includes('P4_ARTIFACT_LOOP_OK'),'SDK export must include the persisted tool-loop conversation');
    const {deflateSync}=await import('node:zlib');
    const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([header,body,tail])};
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(32,0);ihdr.writeUInt32BE(32,4);ihdr[8]=8;ihdr[9]=6;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(32*(32*4+1)))),chunk('IEND',Buffer.alloc(0))]);
    const resized=await resizeImage(png,'image/png',{maxWidth:1,maxHeight:1});
    assert.ok(resized,'SDK image worker/WASM must load');
    assert.equal(resized.width,1);
    console.log('SDK_EXPORT_AND_WASM_OK');
  `], { cwd: serviceDir, env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.match(assets.stdout, /SDK_EXPORT_AND_WASM_OK/);
  const manifest = JSON.parse(await readFile(join(serviceDir, "service-manifest.json"), "utf8"));
  assert.equal(manifest.packages.some((pkg) => ["next", "react", "electron", "typescript"].includes(pkg.name)), false);
  child.stdin.write("shutdown\n");
  assert.equal(await exited, 0, stderr);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

const hostModule = new URL("./web-host.mjs", import.meta.url).href;

async function testManagedWeb(t, blockPrepare) {
  const root = await mkdtemp(join(tmpdir(), "weclio-web-host-"));
  const service = join(root, "build/web-package/service");
  const state = join(root, "state");
  const agent = join(root, "home");
  async function file(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
  await file(join(root, ".next/server/app-paths-manifest.json"), '{"/page":"app/page.js"}');
  await file(join(root, "node_modules/next/index.js"), `module.exports=()=>({ prepare: ${blockPrepare ? "() => { console.log('Next prepare pending'); return new Promise(() => {}); }" : "async () => {}"}, getRequestHandler:()=> (_req,res)=>res.end('fixture UI') });`);
  await file(join(service, "lib/agent/protocol/version-value.mjs"), "export const PROTOCOL_VERSION=1;");
  await file(join(service, "entry.mjs"), `
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const state = process.env.WECLIO_AGENT_STATE_DIR;
const info = {instanceId:'instance',serviceId:'service',protocol:{version:1,minClient:1}};
mkdirSync(state,{recursive:true});
writeFileSync(join(state,'service-token'),'fixture-token');
writeFileSync(join(state,'service.json'),JSON.stringify({...info,pid:process.pid}));
const server = createServer((req,res)=>{
  if (req.headers.authorization !== 'Bearer fixture-token') return res.writeHead(401).end();
  if (req.headers.origin === process.env.WECLIO_AGENT_ALLOWED_ORIGINS) res.setHeader('access-control-allow-origin', req.headers.origin);
  res.end(JSON.stringify(info));
});
server.listen(0,'127.0.0.1',()=>console.log('WECLIO_AGENT_READY '+JSON.stringify({...info,url:'http://127.0.0.1:'+server.address().port})));
function stop() {writeFileSync(join(state,'stopped'),'yes');server.close();process.exit(0);}
process.stdin.on('data',stop);
process.stdin.on('end',stop);
`);
  const script = join(root, "launch.mjs");
  await file(script, `import {runWeb} from ${JSON.stringify(hostModule)};
await runWeb(${JSON.stringify(root)}, {hostname:'127.0.0.1',port:'0',openBrowser:false});`);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: agent, USERPROFILE: agent, WECLIO_AGENT_STATE_DIR: state, WECLIO_AGENT_TOKEN_FILE: "" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    await rm(root, { recursive: true, force: true });
  });
  const readline = createInterface({ input: child.stdout });
  const origin = await Promise.race([exit.then(() => { throw Error(stderr || "Web exited before readiness"); }), (async () => {
    for await (const line of readline) {
      if (blockPrepare && line === "Next prepare pending") return undefined;
      if (line.startsWith("Weclio ready: ")) return line.slice(14);
    }
    throw Error(stderr || "No readiness line");
  })()]);
  if (blockPrepare) {
    child.stdin.write("shutdown\n");
    const deadline = AbortSignal.timeout(3_000);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit", { signal: deadline });
    assert.deepEqual(await exit, [0, null], stderr);
    assert.equal(await readFile(join(state, "stopped"), "utf8"), "yes");
    return;
  }
  const response = await fetch(origin);
  assert.equal(await response.text(), "fixture UI");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const endpoint = origin + "/_weclio/connection";
  const bootstrap = (origin) => fetch(endpoint, { method: "POST", headers: { Origin: origin, "X-Weclio-Bootstrap": "1" } });
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await bootstrap("http://other.invalid")).status, 403);
  const allowed = await bootstrap(origin);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  const { baseUrl, token } = await allowed.json();
  assert.equal((await fetch(baseUrl + "/v1/info", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  child.stdin.end("shutdown\n");
  assert.deepEqual(await exit, [0, null], stderr);
  assert.equal(await readFile(join(state, "stopped"), "utf8"), "yes");
}

test("managed Web bootstraps the ready owned Service only to same-origin local UI", { timeout: 20_000 }, (t) => testManagedWeb(t, false));
test("managed Web stops its Service even when Next preparation is pending", { timeout: 20_000 }, (t) => testManagedWeb(t, true));

test("explicit attach never starts or stops an external Service", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-web-attach-"));
  const protocol = join(root, "build/web-package/service/lib/agent/protocol");
  const next = join(root, "node_modules/next");
  const tokenFile = join(root, "token");
  const external = createServer((req, res) => {
    if (req.url !== "/v1/info" || req.headers.authorization !== "Bearer fixture") return res.writeHead(401).end();
    if (req.headers.origin) res.setHeader("access-control-allow-origin", req.headers.origin);
    res.end(JSON.stringify({ protocol: { version: 1, minClient: 1 } }));
  });
  external.listen(0, "127.0.0.1");
  await once(external, "listening");
  t.after(async () => {
    external.closeAllConnections();
    await new Promise(resolve => external.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${external.address().port}`;
  await mkdir(protocol, { recursive: true });
  await mkdir(next, { recursive: true });
  await writeFile(join(protocol, "version-value.mjs"), "export const PROTOCOL_VERSION=1;");
  await writeFile(join(next, "index.js"), "module.exports=()=>({prepare:async()=>{}, getRequestHandler:()=> (_req,res)=>res.end('UI')});");
  await writeFile(tokenFile, "fixture");
  const script = `import {runWeb} from ${JSON.stringify(hostModule)};
    process.stdin.once('data',()=>process.emit('SIGINT'));
    try { await runWeb(${JSON.stringify(root)}, ${JSON.stringify({ hostname: "127.0.0.1", port: "0", openBrowser: false, attach: { serviceUrl: baseUrl, tokenFile } })}); }
    finally { process.stdin.destroy(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const exit = once(child, "exit");
  try {
    const lines = createInterface({ input: child.stdout });
    let origin;
    for await (const line of lines) {
      if (line.startsWith("Weclio ready: ")) { origin = line.slice(14); break; }
    }
    assert.ok(origin, "there is deliberately no Service entrypoint in the Web fixture");
    const response = await fetch(`${origin}/_weclio/connection`, { method: "POST", headers: { Origin: origin, "X-Weclio-Bootstrap": "1" } });
    assert.deepEqual(await response.json(), { baseUrl, token: "fixture" });
    child.stdin.end("stop");
    assert.deepEqual(await exit, [0, null]);
    assert.equal((await fetch(`${baseUrl}/v1/info`, { headers: { Authorization: "Bearer fixture" } })).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  }
});

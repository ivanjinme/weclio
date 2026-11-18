import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, truncateSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import JSZip from "jszip";

const base = mkdtempSync(join(tmpdir(), "weclio-resource-http-"));
const workspace = join(base, "workspace");
mkdirSync(workspace);
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const priorOrigins = process.env.WECLIO_AGENT_ALLOWED_ORIGINS;
const priorRoots = globalThis.__piAllowedRootsCache;
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.WECLIO_AGENT_ALLOWED_ORIGINS = "http://trusted.example,weclio://app,*";
const jiti = createJiti(import.meta.url);
const { startAgentServiceHost } = await jiti.import("./host.ts");
const { AgentRuntime } = await jiti.import("../../rpc-manager.ts");
const token = "service-secret-not-a-resource-ticket";
const config = { host: "127.0.0.1", port: 0, token, workspace };
const options = { runtime: new AgentRuntime(), config, serviceId: "test", instanceId: "test-instance", appVersion: "test" };
const authorize = (...roots) => {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
};
const filePath = join(workspace, "a.pdf");
writeFileSync(filePath, "0123456789");
const host = await startAgentServiceHost(options);
const call = (route, init) => fetch(host.url + route, init);
const content = (ticket) => `/v1/resources/content?ticket=${encodeURIComponent(ticket)}`;
async function issue(file = filePath, kind = "read", headers = { Authorization: `Bearer ${token}` }, sessionId, source) {
  return call("/v1/resources/tickets", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ filePath: file, kind, sessionId, source }),
  });
}
function protectedHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}
test.after(async () => {
  await host.close();
  globalThis.__piAllowedRootsCache = priorRoots;
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  if (priorOrigins === undefined) delete process.env.WECLIO_AGENT_ALLOWED_ORIGINS; else process.env.WECLIO_AGENT_ALLOWED_ORIGINS = priorOrigins;
  rmSync(base, { recursive: true, force: true });
});

test("real HTTP: ticket issuance authorization, regular/binary files and preview limits", async () => {
  authorize(workspace);
  const noAuth = await issue(filePath, "read", {});
  assert.equal(noAuth.status, 401);
  protectedHeaders(noAuth);
  assert.equal((await issue(filePath, "read", { Authorization: `Bearer ${token}`, Origin: "http://evil.example" })).status, 403);
  const outside = join(base, "outside.pdf");
  writeFileSync(outside, "private");
  assert.equal((await issue(outside)).status, 403);
  assert.equal((await issue(workspace, "download")).status, 400);
  const text = join(workspace, "a.json");
  writeFileSync(text, "{}");
  assert.equal((await issue(text)).status, 400);
  assert.equal((await issue(text, "preview")).status, 400);
  const large = join(workspace, "large.docx");
  writeFileSync(large, "");
  truncateSync(large, 11 * 1024 * 1024);
  assert.equal((await issue(large, "preview")).status, 413);
  const ok = await issue();
  protectedHeaders(ok);
  const value = await ok.json();
  assert.equal(typeof value.ticket, "string");
  assert.ok(value.expiresAt > Date.now());
  assert.ok(!value.ticket.includes(token));
});

test("real HTTP: native anonymous GET, Range, HEAD and 416", async () => {
  authorize(workspace);
  const { ticket } = await (await issue()).json();
  const route = content(ticket);
  const full = await call(route);
  assert.equal(full.status, 200);
  protectedHeaders(full);
  assert.equal(full.headers.get("content-type"), "application/pdf");
  assert.equal(await full.text(), "0123456789");
  const range = await call(route, { headers: { Range: "bytes=2-4" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(range.headers.get("content-length"), "3");
  assert.equal(await range.text(), "234");
  for (const headers of [{}, { Range: "bytes=2-4" }]) {
    const head = await call(route, { method: "HEAD", headers });
    assert.equal(head.status, 200, "HEAD ignores Range and describes the complete representation");
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    protectedHeaders(head);
  }
  const invalid = await call(route, { headers: { Range: "bytes=100-200" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
  protectedHeaders(invalid);
  const download = await (await issue(filePath, "download")).json();
  assert.match((await call(content(download.ticket))).headers.get("content-disposition"), /^attachment;/);
});

test("real HTTP: DOCX preview CSP permits only configured UI origins and HEAD has no body", async () => {
  authorize(workspace);
  const docx = join(workspace, "preview.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Preview fixture</w:t></w:r></w:p></w:body></w:document>');
  writeFileSync(docx, await zip.generateAsync({ type: "nodebuffer" }));
  const { ticket } = await (await issue(docx, "preview")).json();
  const response = await call(content(ticket));
  assert.equal(response.status, 200);
  protectedHeaders(response);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self' http:\/\/trusted\.example weclio:\/\/app$/);
  assert.ok(!csp.includes("*"));
  const html = await response.text();
  assert.match(html, /Preview fixture/);
  const head = await call(content(ticket), { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(html)));
  assert.equal(await head.text(), "");
});

test("real HTTP: ticket scope, strict query, origin policy and per-host rotation", async () => {
  authorize(workspace);
  const { ticket } = await (await issue()).json();
  const route = content(ticket);
  for (const query of ["&filePath=elsewhere", "&kind=download", "&sessionId=x", "&ticket=x", "&x="]) {
    const denied = await call(route + query);
    assert.equal(denied.status, 400);
    protectedHeaders(denied);
  }
  for (const bad of ["", "invalid", ticket + "tamper"]) assert.equal((await call(content(bad))).status, 401);
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await call(route, { method })).status, 401);
    assert.equal((await call(route, { method, headers: { Authorization: `Bearer ${token}` } })).status, 404);
  }
  for (const other of ["/v1/info", "/v1/files/index", "/v1/sessions/x/commands", `/v1/files/${filePath.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}?type=read`]) {
    assert.equal((await call(other + (other.includes("?") ? "&" : "?") + `ticket=${ticket}`)).status, 401);
    assert.equal((await call(other, { headers: { Authorization: `Bearer ${ticket}` } })).status, 401);
  }
  const evil = await call(route, { headers: { Origin: "http://evil.example" } });
  assert.equal(evil.status, 403);
  protectedHeaders(evil);
  const trusted = await call(route, { headers: { Origin: "http://trusted.example" } });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.headers.get("access-control-allow-origin"), "http://trusted.example");
  const rotated = await startAgentServiceHost(options);
  try { assert.equal((await fetch(rotated.url + route)).status, 401); } finally { await rotated.close(); }
});

test("real HTTP: session references are required again at redemption", async () => {
  authorize();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const external = join(base, "referenced.pdf");
  writeFileSync(external, "reference-only");
  const manager = SessionManager.create(workspace);
  manager.appendMessage({ role: "user", content: external, timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  const priorPaths = globalThis.__piSessionPathCache;
  globalThis.__piSessionPathCache = new Map([[sessionId, sessionFile]]);
  try {
    assert.equal((await issue(external)).status, 403);
    const issued = await issue(external, "read", undefined, sessionId);
    assert.equal(issued.status, 200);
    const { ticket } = await issued.json();
    assert.equal((await call(content(ticket))).status, 200);
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: workspace, timestamp: new Date().toISOString() }) + "\n");
    assert.equal((await call(content(ticket))).status, 403);
  } finally { globalThis.__piSessionPathCache = priorPaths; }
});

test("real HTTP: a referenced file cannot redirect its ticket through a replaced parent link", async (t) => {
  authorize();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const folder = join(base, "reference-folder");
  const elsewhere = join(base, "different-folder");
  mkdirSync(folder); mkdirSync(elsewhere);
  const referenced = join(folder, "file.pdf");
  writeFileSync(referenced, "original");
  writeFileSync(join(elsewhere, "file.pdf"), "different");
  const manager = SessionManager.create(workspace);
  manager.appendMessage({ role: "user", content: referenced, timestamp: Date.now() });
  const id = manager.getSessionId();
  const priorPaths = globalThis.__piSessionPathCache;
  globalThis.__piSessionPathCache = new Map([[id, manager.getSessionFile()]]);
  try {
    const issued = await issue(referenced, "read", undefined, id);
    assert.equal(issued.status, 200);
    const { ticket } = await issued.json();
    renameSync(folder, folder + "-original");
    try { symlinkSync(elsewhere, folder, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
      if (error.code === "EPERM") { t.skip("Directory link privilege unavailable"); return; }
      throw error;
    }
    assert.equal((await call(content(ticket))).status, 403);
  } finally { globalThis.__piSessionPathCache = priorPaths; }
});

test("real HTTP: bash-output tickets retain the specialized spill/session policy", async () => {
  authorize(workspace, tmpdir());
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const spill = join(tmpdir(), `pi-bash-resource-${Date.now()}.log`);
  const arbitrary = join(workspace, "arbitrary.log");
  const unreferenced = join(tmpdir(), `pi-bash-unrelated-${Date.now()}.log`);
  writeFileSync(spill, "0123456789");
  writeFileSync(arbitrary, "not a spill");
  writeFileSync(unreferenced, "another session");
  const manager = SessionManager.create(workspace);
  manager.appendMessage({ role: "user", content: unreferenced, timestamp: Date.now() });
  manager.appendMessage({ role: "bashExecution", command: "fixture", output: "truncated", exitCode: 0,
    cancelled: false, truncated: true, fullOutputPath: spill, timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  const priorPaths = globalThis.__piSessionPathCache;
  globalThis.__piSessionPathCache = new Map([[sessionId, sessionFile]]);
  try {
    for (const [kind, session, source] of [["read", sessionId, "bash-output"], ["preview", sessionId, "bash-output"],
      ["download", undefined, "bash-output"], ["download", "", "bash-output"], ["download", sessionId, "unknown"]]) {
      assert.equal((await issue(spill, kind, undefined, session, source)).status, 400);
    }
    assert.equal((await issue(arbitrary, "download", undefined, sessionId, "bash-output")).status, 400);
    assert.equal((await issue(unreferenced, "download", undefined, sessionId, "bash-output")).status, 403,
      "a general user-message path reference cannot authorize a bash spill");
    assert.equal((await issue(spill, "download", undefined, "00000000-0000-0000-0000-000000000000", "bash-output")).status, 403);
    const issued = await issue(spill, "download", undefined, sessionId, "bash-output");
    assert.equal(issued.status, 200);
    const { ticket } = await issued.json();
    const route = content(ticket);
    const full = await call(route);
    assert.equal(full.status, 200);
    protectedHeaders(full);
    assert.equal(full.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(full.headers.get("content-disposition"), /^attachment;/);
    assert.equal(await full.text(), "0123456789");
    const range = await call(route, { headers: { Range: "bytes=2-4" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "234");
    for (let index = 0; index < 3; index++) {
      const head = await call(route, { method: "HEAD", headers: { Range: "bytes=2-4" } });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), "10");
      assert.equal(await head.text(), "");
      assert.equal((await call(route, { headers: { Range: "bytes=100-200" } })).status, 416);
    }
    for (const override of ["&source=other", "&kind=read", "&sessionId=other"]) assert.equal((await call(route + override)).status, 400);
    const [payload, signature] = ticket.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    for (const changed of [{ ...claims, source: undefined }, { ...claims, kind: "read" }]) {
      assert.equal((await call(content(Buffer.from(JSON.stringify(changed)).toString("base64url") + "." + signature))).status, 401);
    }
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: workspace, timestamp: new Date().toISOString() }) + "\n");
    assert.equal((await call(route)).status, 403, "redemption must recheck the specialized session reference");
  } finally {
    globalThis.__piSessionPathCache = priorPaths;
    rmSync(spill, { force: true });
    rmSync(unreferenced, { force: true });
  }
});

test("real HTTP: redemption rechecks roots and realpath after issue", async (t) => {
  authorize(workspace);
  const { ticket } = await (await issue()).json();
  authorize();
  assert.equal((await call(content(ticket))).status, 403);
  authorize(workspace);
  const swapped = join(workspace, "swapped.pdf");
  const outside = join(base, "outside.pdf");
  writeFileSync(swapped, "initial");
  const issued = await (await issue(swapped)).json();
  rmSync(swapped);
  try { symlinkSync(outside, swapped); } catch (error) {
    if (error.code === "EPERM") { t.diagnostic("symlink replacement skipped: Windows privilege unavailable"); return; }
    throw error;
  }
  assert.equal((await call(content(issued.ticket))).status, 403);
});

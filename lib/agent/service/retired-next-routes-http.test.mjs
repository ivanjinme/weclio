import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 已退役 Next 适配器的安全回归必须经过真实 Service HTTP。
const root = realpathSync(mkdtempSync(join(tmpdir(), "weclio-http-boundary-")));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRoots = globalThis.__piAllowedRootsCache;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { startAgentServiceHost } = await createJiti(import.meta.url).import("./host.ts");
const token = "fixture-only";
const host = await startAgentServiceHost({
  runtime: {}, config: { host: "127.0.0.1", port: 0, token, workspace },
  serviceId: "test", instanceId: "test", appVersion: "test",
});
const call = (route, init = {}) => fetch(host.url + route, {
  ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
});
const authorize = (cwd) => {
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Date.now() + 60_000 };
};
const fileRoute = (file) => "/v1/files/" + file.replaceAll("\\", "/").split("/").filter(Boolean).map(encodeURIComponent).join("/") + "?type=read";
const diff = (cwd, file) => call(`/v1/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(file)}`);
test.after(async () => {
  await host.close();
  globalThis.__piAllowedRootsCache = previousRoots;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("Service binary responses preserve MIME, bytes, Range and SVG CSP on every response shape", async () => {
  authorize(workspace);
  const svg = join(workspace, "script.svg");
  const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(svg, body);
  for (const [headers, status] of [[{}, 200], [{ Range: "bytes=0-3" }, 206], [{ Range: "bytes=9999-" }, 416]]) {
    const response = await call(fileRoute(svg), { headers });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'self'/);
    if (status === 200) assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    if (status === 206) {
      assert.equal(response.headers.get("content-range"), `bytes 0-3/${body.length}`);
      assert.equal(await response.text(), "<svg");
    }
    if (status === 416) assert.equal(response.headers.get("content-range"), `bytes */${body.length}`);
  }
  const pdf = join(workspace, "binary.pdf");
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(pdf, bytes);
  const response = await call(fileRoute(pdf));
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("Service Git diff rejects traversal and linked escape, but serves deleted tracked files", async (t) => {
  const repo = join(workspace, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  authorize(repo);
  const nested = join(repo, "nested");
  mkdirSync(nested);
  assert.equal((await diff(repo, repo + sep + "nested" + sep + ".." + sep + "file.txt")).status, 403);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  try {
    symlinkSync(outside, join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await diff(repo, join(repo, "linked", "secret.txt"))).status, 403);
    assert.equal((await diff(repo, join(repo, "linked", "missing", "secret.txt"))).status, 403);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    t.diagnostic("Symlink assertions unavailable without Windows privileges; traversal/deletion still run");
  }
  const file = join(nested, "gone.txt");
  writeFileSync(file, "original\n");
  execFileSync("git", ["-C", repo, "add", "nested"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  rmSync(nested, { recursive: true });
  const response = await diff(repo, file);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.supported, true);
  assert.equal(value.status, "deleted");
});

test("Service text writes retain media type, byte limits and exact text behavior", async () => {
  authorize(workspace);
  const file = join(workspace, "edit.txt");
  writeFileSync(file, "original");
  const route = fileRoute(file);
  const wrongType = await call(route, { method: "PUT", headers: { "content-type": "application/json" }, body: '"changed"' });
  assert.equal(wrongType.status, 415);
  const tooLarge = await call(route, { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: "中".repeat(90000) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await (await call(route)).json()).content, "original");
  for (const text of ["\ufeff中文\r\n\r\n", ""]) {
    const response = await call(route, { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: text });
    assert.equal(response.status, 200);
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("Service sessions reject malformed titles and names and map missing mutations to 404", async () => {
  for (const body of [null, {}, { ids: "thread" }, { ids: [42] }, { ids: Array(101).fill("id") }]) {
    const response = await call("/v1/sessions/titles", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_argument");
  }
  assert.equal((await call("/v1/sessions/titles", { method: "POST", body: "{" })).status, 400);
  const invalidName = await call("/v1/sessions/missing", { method: "PATCH", body: "{}" });
  assert.equal(invalidName.status, 400);
  for (const [route, method, body] of [
    ["/v1/sessions/missing", "GET"],
    ["/v1/sessions/missing", "DELETE"],
    ["/v1/sessions/missing", "PATCH", JSON.stringify({ name: "Manual" })],
    ["/v1/sessions/missing/auto-name", "POST"],
  ]) {
    const response = await call(route, { method, body });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "session_not_found");
  }
  const usage = await call("/v1/usage/codex");
  assert.equal(usage.status, 200);
  assert.equal(usage.headers.get("cache-control"), "no-store");
});

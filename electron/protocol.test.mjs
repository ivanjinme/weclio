import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  assetHeaders,
  contentTypeFor,
  createAppProtocolHandler,
  registerAppScheme,
  resolveAppAsset,
} from "./protocol.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "weclio-app-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "app.css"), "body{}");
  writeFileSync(join(root, "assets", "font.woff2"), "w");
  return root;
}

test("the app scheme is registered as standard, secure and fetch-capable", () => {
  const calls = [];
  registerAppScheme({ registerSchemesAsPrivileged: (value) => calls.push(value) });
  assert.equal(calls.length, 1);
  const [definition] = calls[0];
  assert.equal(definition.scheme, "weclio");
  assert.equal(definition.privileges.standard, true);
  assert.equal(definition.privileges.secure, true);
  assert.equal(definition.privileges.supportFetchAPI, true);
});

test("the entry URL is a stable origin, not a file path", () => {
  assert.equal(APP_ORIGIN, "weclio://app");
  assert.equal(APP_ENTRY_URL, "weclio://app/index.html");
});

test("root and bare paths resolve to index.html", (t) => {
  const root = fixture(t);
  assert.equal(resolveAppAsset(root, "weclio://app/"), join(root, "index.html"));
  assert.equal(resolveAppAsset(root, "weclio://app"), join(root, "index.html"));
  assert.equal(resolveAppAsset(root, "weclio://app/assets/index-abc.js"), join(root, "assets", "index-abc.js"));
});

test("traversal can never resolve outside the app root", (t) => {
  const root = fixture(t);
  const hostile = [
    "weclio://app/../secret.txt",
    "weclio://app/assets/../../secret.txt",
    "weclio://app/%2e%2e/secret.txt",
    "weclio://app/%2e%2e%2fsecret.txt",
    "weclio://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "weclio://app//etc/passwd",
  ];
  // URL 规范化或路径守卫至少有一层必须拦住；结果只能为空或在根内。
  for (const url of hostile) {
    const resolved = resolveAppAsset(root, url);
    if (resolved === null) continue;
    assert.ok(resolved === root || resolved.startsWith(root + sep), `escaped root via ${url}: ${resolved}`);
  }
  // 编码后的 parent 段在解码后被守卫拦下。
  assert.equal(resolveAppAsset(root, "weclio://app/%2e%2e%2fsecret.txt"), null);
  assert.equal(resolveAppAsset(root, "weclio://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt"), null);
});

test("foreign schemes, hosts and malformed URLs are refused", (t) => {
  const root = fixture(t);
  for (const url of ["weclio://other/index.html", "http://app/index.html", "file:///index.html", "not a url", ""]) {
    assert.equal(resolveAppAsset(root, url), null, `must reject ${url}`);
  }
});

test("a sibling directory sharing the root prefix is not authorized", (t) => {
  const root = fixture(t);
  const sibling = `${root}-evil`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "secret.txt"), "secret");
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  const name = sibling.split(/[\/]/).pop();
  assert.equal(resolveAppAsset(root, `weclio://app/..%2f${name}%2fsecret.txt`), null);
});

test("content types cover scripts, styles, fonts and wasm", () => {
  assert.match(contentTypeFor("a.html"), /text\/html/);
  assert.match(contentTypeFor("a.js"), /javascript/);
  assert.match(contentTypeFor("a.css"), /text\/css/);
  assert.equal(contentTypeFor("a.woff2"), "font/woff2");
  assert.equal(contentTypeFor("a.wasm"), "application/wasm");
  assert.equal(contentTypeFor("a.unknown"), "application/octet-stream");
});

test("assets carry a restrictive CSP and nosniff", () => {
  const headers = assetHeaders("index.html");
  assert.match(headers["content-security-policy"], /default-src 'self'/);
  assert.match(headers["content-security-policy"], /object-src 'none'/);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(headers["x-content-type-options"], "nosniff");
});

test("the handler serves files, 404s missing ones and never escapes the root", async (t) => {
  const root = fixture(t);
  const handler = createAppProtocolHandler(root);

  const ok = await handler({ url: "weclio://app/index.html" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /text\/html/);
  assert.equal(await ok.text(), "<!doctype html><title>t</title>");

  const script = await handler({ url: "weclio://app/assets/index-abc.js" });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  assert.equal((await handler({ url: "weclio://app/missing.js" })).status, 404);
  assert.equal((await handler({ url: "weclio://app/../outside.txt" })).status, 404);
  assert.equal((await handler({ url: "weclio://app/assets" })).status, 404, "directories are not served");
});

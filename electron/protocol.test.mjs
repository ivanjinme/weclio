import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  for (const url of ["weclio://other/index.html", "weclio://user:pass@app/index.html", "weclio://app:8888/index.html", "http://app/index.html", "file:///index.html", "not a url", ""]) {
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

function directives(csp) {
  return Object.fromEntries(csp.split("; ").map((value) => {
    const [name, ...sources] = value.split(" ");
    return [name, sources];
  }));
}

test("without a selected Service, network access is not granted except Markdown images", () => {
  const csp = directives(assetHeaders("index.html")["content-security-policy"]);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["media-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["frame-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["img-src"], ["'self'", "data:", "blob:", "http:", "https:"]);
  assert.deepEqual(csp["script-src"], ["'self'"]);
  assert.deepEqual(csp["style-src"], ["'self'", "'unsafe-inline'"]);
});

test("only the explicitly selected Service origin is added to API and resource directives", () => {
  for (const serviceUrl of ["http://127.0.0.1:49152", "https://vm.example:8443/", "https://vm.example:443", "http://[::1]:4123"]) {
    const origin = new URL(serviceUrl).origin;
    const csp = directives(assetHeaders("index.html", { serviceUrl })["content-security-policy"]);
    assert.deepEqual(csp["connect-src"], ["'self'", origin]);
    assert.deepEqual(csp["media-src"], ["'self'", "blob:", origin]);
    assert.deepEqual(csp["frame-src"], ["'self'", "blob:", origin]);
    assert.deepEqual(csp["script-src"], ["'self'"]);
  }
});

test("Service URL configuration rejects non-origins, credentials and CSP injection", (t) => {
  const root = fixture(t);
  for (const serviceUrl of [null, "", "not a URL", "file:///app", "weclio://app", "ftp://service.example", "http:service.example", "https://user:pass@service.example", "https://@service.example", "https://service.example/v1", "https://service.example?", "https://service.example?token=secret", "https://service.example#", "https://service.example#fragment", "https://*.example", "https://service.example;script-src *", "https://service.example/;connect-src *", "https://service.example\n", "https://service.example\\"]) {
    assert.throws(() => assetHeaders("index.html", { serviceUrl }), undefined, String(serviceUrl));
    assert.throws(() => createAppProtocolHandler(root, { serviceUrl }), undefined, String(serviceUrl));
  }
});

test("the handler sends the selected Service CSP on HTML and assets", async (t) => {
  const root = fixture(t);
  const serviceUrl = "http://127.0.0.1:49152";
  const handler = createAppProtocolHandler(root, { serviceUrl });
  for (const path of ["/index.html?session=123", "/assets/index-abc.js"]) {
    const response = await handler({ url: `weclio://app${path}` });
    assert.equal(response.status, 200);
    assert.deepEqual(directives(response.headers.get("content-security-policy"))["connect-src"], ["'self'", serviceUrl]);
  }
});

test("the handler rejects symlink/junction escapes but serves links contained in the root", async (t) => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "weclio-protocol-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "outside"), "junction");
  symlinkSync(join(root, "assets"), join(root, "inside"), "junction");
  const handler = createAppProtocolHandler(root);
  assert.equal((await handler({ url: "weclio://app/outside/secret.txt" })).status, 404);
  const inside = await handler({ url: "weclio://app/inside/app.css" });
  assert.equal(inside.status, 200);
  assert.equal(await inside.text(), "body{}");
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

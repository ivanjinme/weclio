import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";
import { assertPortAvailable, waitForServer } from "./server.mjs";

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test("only static application entry paths may navigate inside the desktop", () => {
  for (const url of ["weclio://app", "weclio://app/", "weclio://app/?session=123#message", "weclio://app/index.html?session=123#message"]) {
    assert.equal(isAppUrl(url), true, url);
  }
  for (const url of ["http://127.0.0.1:8888", "http://127.0.0.1:8888/?session=123", "weclio://app/assets/app.js", "weclio://app/other.html", "weclio://app/index.html/", "weclio://other/index.html", "weclio://user:pass@app/index.html", "weclio://app:8888/index.html", "https://example.com", "http://127.0.0.1:8889", "http://127.0.0.1:9999", "http://localhost:8888", "http://127.0.0.1:8888.evil.com", "file:///C:/secret", "javascript:alert(1)", "invalid"]) {
    assert.equal(isAppUrl(url), false, url);
  }
});

test("only external HTTP(S) links may open outside the desktop", () => {
  assert.equal(isExternalUrl("https://example.com/docs"), true);
  assert.equal(isExternalUrl("http://example.com/docs"), true);
  assert.equal(isExternalUrl("http://127.0.0.1:8888"), true);
  for (const url of ["weclio://app/", "weclio://app/index.html", "file:///C:/secret", "mailto:test@example.com", "vscode://file/test", "javascript:alert(1)", "data:text/html,test", "invalid"]) {
    assert.equal(isExternalUrl(url), false, url);
  }
});

test("clipboard writes are allowed only for the application origin", () => {
  for (const url of ["weclio://app", "weclio://app/", "weclio://app/index.html?session=123#message"]) {
    assert.equal(isPermissionAllowed("clipboard-sanitized-write", url), true, url);
  }
  for (const url of ["http://127.0.0.1:8888", "weclio://app/assets/app.js", "weclio://user:pass@app/", "weclio://app:8888/", "https://example.com", "http://127.0.0.1:8889", "http://localhost:8888", "file:///C:/secret", "data:text/html,test", "invalid", "", undefined]) {
    assert.equal(isPermissionAllowed("clipboard-sanitized-write", url), false, String(url));
  }
});

test("clipboard reads and other permissions remain denied for the application", () => {
  for (const permission of ["clipboard-read", "deprecated-sync-clipboard-read", "media", "geolocation", "notifications", "openExternal", "unknown"]) {
    assert.equal(isPermissionAllowed(permission, "weclio://app/index.html"), false, permission);
  }
});

test("an occupied port is rejected without stopping or changing its server", async (t) => {
  const { port, url } = await serve(t, (_request, response) => response.end("existing"));
  await assert.rejects(assertPortAvailable(port), /已被占用/);
  assert.equal(await (await fetch(url)).text(), "existing");
});

test("port probe releases its listener", async () => {
  await assertPortAvailable(0);
});

test("readiness requires both the owned process readiness and an HTTP 200", async (t) => {
  let requests = 0;
  let ready = false;
  const { url } = await serve(t, (_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 503 : 200).end();
  });
  const controller = new AbortController();
  const waiting = waitForServer(url, { signal: controller.signal, isReady: () => ready, timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, 0, "must not probe another process before the owned server is ready");
  ready = true;
  await waiting;
  assert.equal(requests, 2);
});

test("startup has a bounded timeout", async () => {
  await assert.rejects(waitForServer("http://127.0.0.1:1", {
    signal: new AbortController().signal,
    isReady: () => true,
    timeout: 50,
  }), /未就绪/);
});

test("a streaming response cannot bypass the total startup deadline", async (t) => {
  const { url } = await serve(t, (_request, response) => {
    response.writeHead(200);
    response.write("partial HTML");
    const timer = setInterval(() => response.write(" "), 10);
    response.once("close", () => clearInterval(timer));
  });
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 2000);
  const start = Date.now();
  try {
    await assert.rejects(waitForServer(url, { signal: controller.signal, isReady: () => true, timeout: 100 }), /未就绪/);
    assert.ok(Date.now() - start < 1500);
  } finally {
    clearTimeout(safety);
  }
});

test("shutdown aborts startup polling", async () => {
  const controller = new AbortController();
  const waiting = waitForServer("http://127.0.0.1:1", {
    signal: controller.signal,
    isReady: () => false,
  });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("shutdown aborts an in-flight HTTP readiness request", async (t) => {
  const controller = new AbortController();
  const { url } = await serve(t, () => controller.abort());
  await assert.rejects(waitForServer(url, {
    signal: controller.signal,
    isReady: () => true,
  }), { name: "AbortError" });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";

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

import assert from "node:assert/strict";
import test from "node:test";
import { npxEnvironment } from "./npx.ts";

test("npx children omit server-only variables but retain install requirements", () => {
  const original = {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.example:8080",
    GITHUB_TOKEN: "plugin-install-token",
    PORT: "8888",
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    NEXT_PUBLIC_URL: "http://localhost",
    PI_WEB_PASSWORD: "server-login-secret",
    FORCE_COLOR: "3",
  };
  const snapshot = { ...original };
  assert.deepEqual(npxEnvironment(original, "linux"), {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.example:8080",
    GITHUB_TOKEN: "plugin-install-token",
    FORCE_COLOR: "0",
  });
  assert.deepEqual(original, snapshot);
});

test("npx environment sanitization handles Windows environment-name casing", () => {
  const source = { Path: "C:\\bin", next_runtime: "edge", port: "8080", pi_web_password: "hidden", force_color: "3", npm_config_registry: "https://registry.npmjs.org" };
  assert.deepEqual(npxEnvironment(source, "win32"), {
    Path: "C:\\bin",
    npm_config_registry: "https://registry.npmjs.org",
    FORCE_COLOR: "0",
  });
});

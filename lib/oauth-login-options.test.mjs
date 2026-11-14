import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOAuthLoginOptions } from "./oauth-login-options.ts";

test("ChatGPT login option persists the same Pi device ID across sessions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-device-id-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createOAuthLoginOptions(dir);
  const deviceId = first.options.getDeviceId();
  assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(first.options.getDeviceId(), deviceId);
  await first.flush();
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(settings.deviceId, deviceId);
  assert.equal(createOAuthLoginOptions(dir).options.getDeviceId(), deviceId);
});

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
  const second = createOAuthLoginOptions(dir);
  assert.equal(second.options.getDeviceId(), deviceId);
  await second.flush();
});

test("flush rejects real device ID write failures recorded by SettingsManager", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-device-id-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const login = createOAuthLoginOptions(dir);
  login.options.getDeviceId();
  // 用目录占据文件路径，在所有平台上制造真实写入错误。
  fs.mkdirSync(path.join(dir, "settings.json"));
  await assert.rejects(login.flush(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.length > 0);
    assert.ok(error.errors.every((cause) => cause instanceof Error));
    return true;
  });
  // drainErrors 消费已报告错误，不会在后续 flush 中重复抛出。
  await login.flush();
});

test("flush also reports settings load errors that prevent device ID persistence", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-device-id-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "settings.json"), "{invalid json");
  const login = createOAuthLoginOptions(dir);
  login.options.getDeviceId();
  await assert.rejects(login.flush(), AggregateError);
});

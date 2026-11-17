import assert from "node:assert/strict";
import test from "node:test";
import { createServiceControl } from "./service-control.mjs";

function harness() {
  const written = [];
  const control = createServiceControl({ write: (line) => written.push(JSON.parse(line)) });
  return { control, written, reply: (value) => control.onLine(`WECLIO_AGENT_CONTROL ${JSON.stringify(value)}`) };
}

test("requests are correlated by id and only accept action-appropriate statuses", async () => {
  const { control, written, reply } = harness();
  const inspecting = control.inspect();
  assert.deepEqual(written[0], { id: 1, action: "inspect" });
  const locking = control.lock();
  assert.equal(written[1].id, 2);
  reply({ id: 2, status: "busy" });
  reply({ id: 1, status: "ready" });
  assert.equal(await inspecting, "ready");
  assert.equal(await locking, "busy");
  const unlocking = control.unlock();
  reply({ id: 3, status: "ready" });
  await assert.rejects(unlocking, /Malformed/);
  const again = control.unlock();
  reply({ id: 4, status: "unlocked" });
  assert.equal(await again, "unlocked");
});

test("timeouts and channel loss reject instead of reporting a false ready", async () => {
  const control = createServiceControl({ write: () => {}, timeoutMs: 20 });
  await assert.rejects(control.lock(), /timed out/);
  const disconnected = createServiceControl({ write: () => {} });
  disconnected.disconnect();
  await assert.rejects(disconnected.inspect(), /unavailable/);
});

test("late replies after a timeout cannot advance later requests or unlock state", async () => {
  const { control, reply } = harness();
  const unlock = control.unlock();
  reply({ id: 1, status: "unlocked" });
  assert.equal(await unlock, "unlocked");
  // 重复 id 回复被忽略，不会误解除后续请求。
  const inspect = control.inspect();
  reply({ id: 1, status: "ready" });
  reply({ id: 2, status: "busy" });
  assert.equal(await inspect, "busy");
});

test("malformed or foreign lines never resolve a pending gate request", async () => {
  const { control } = harness();
  const pending = control.lock();
  assert.equal(control.onLine("WECLIO_AGENT_CONTROL {"), true);
  assert.equal(control.onLine("WECLIO_AGENT_CONTROL null"), true);
  assert.equal(control.onLine("WECLIO_AGENT_READY {}"), false);
  assert.equal(control.onLine("random log line"), false);
  await assert.rejects(pending, /Malformed/);
});

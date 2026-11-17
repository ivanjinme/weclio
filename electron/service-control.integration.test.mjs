import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createServiceControl } from "./service-control.mjs";

const jiti = createJiti(import.meta.url);
const { handleMaintenanceLine } = await jiti.import("../lib/agent/service/maintenance-control.ts");
const { Admission } = await jiti.import("../lib/agent/admission.ts");

/** 用真实解析器与真实控制客户端对接，验证更新门禁的跨进程协议契约。 */
function wiring({ busy = false } = {}) {
  const written = [];
  let active = busy;
  const runtime = { admission: new Admission(), hasBusyTasks: () => active };
  const replies = [];
  const control = createServiceControl({ write: (line) => written.push(JSON.parse(line)) });
  const deliver = () => {
    while (written.length) {
      const request = written.shift();
      const reply = handleMaintenanceLine(runtime, JSON.stringify(request));
      assert.ok(reply, "every well-formed request is answered");
      assert.equal(control.onLine(`WECLIO_AGENT_CONTROL ${JSON.stringify(reply)}`), true);
      replies.push(reply);
    }
  };
  return { control, runtime, deliver, replies, setBusy(value) { active = value; } };
}

test("installer gate round-trips inspect/lock/unlock through the private pipe protocol", async () => {
  const { control, runtime, deliver, replies } = wiring();
  const inspecting = control.inspect(); deliver();
  assert.equal(await inspecting, "ready");
  const locking = control.lock(); deliver();
  assert.equal(await locking, "ready");
  assert.equal(runtime.admission.isLocked(), true);
  assert.throws(() => runtime.admission.reserve(), /maintenance/);
  const unlocking = control.unlock(); deliver();
  assert.equal(await unlocking, "unlocked");
  assert.equal(runtime.admission.isLocked(), false);
  assert.deepEqual(replies.map((reply) => reply.status), ["ready", "ready", "unlocked"]);
});

test("a busy Service refuses the update lock and stays usable", async () => {
  const { control, runtime, deliver, setBusy } = wiring({ busy: true });
  const inspecting = control.inspect(); deliver();
  assert.equal(await inspecting, "busy");
  const locking = control.lock(); deliver();
  assert.equal(await locking, "busy");
  assert.equal(runtime.admission.isLocked(), false, "a refused update must not lock the Service");
  setBusy(false);
  const retry = control.lock(); deliver();
  assert.equal(await retry, "ready");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { Admission } = await jiti.import("../admission.ts");
const { handleMaintenanceLine } = await jiti.import("./maintenance-control.ts");
function fixture() {
  let active = false;
  const runtime = { admission: new Admission(), hasBusyTasks: () => active };
  const call = (action, id = 1) => handleMaintenanceLine(runtime, JSON.stringify({ id, action }));
  return { runtime, call, setActive(value) { active = value; } };
}

test("private inspect is read-only and lock atomically blocks new admissions until unlock", () => {
  const { runtime, call } = fixture();
  assert.deepEqual(call("inspect"), { id: 1, status: "ready" });
  assert.equal(runtime.admission.isLocked(), false);
  assert.deepEqual(call("lock", 2), { id: 2, status: "ready" });
  assert.throws(() => runtime.admission.reserve(), /maintenance/);
  assert.deepEqual(call("lock", 3), { id: 3, status: "ready" });
  assert.deepEqual(call("unlock", 4), { id: 4, status: "unlocked" });
  runtime.admission.reserve()();
});

test("a task reserved after inspect wins the race and the lock stays open", () => {
  const { runtime, call } = fixture();
  assert.equal(call("inspect").status, "ready");
  const finish = runtime.admission.reserve();
  assert.equal(call("lock").status, "busy");
  assert.equal(runtime.admission.isLocked(), false);
  finish();
  assert.equal(call("lock").status, "ready");
});

test("runtime async activity blocks the same lock even without a pending HTTP reservation", () => {
  const { runtime, call, setActive } = fixture();
  setActive(true);
  assert.equal(call("inspect").status, "busy");
  assert.equal(call("lock").status, "busy");
  assert.equal(runtime.admission.isLocked(), false);
  setActive(false);
  assert.equal(call("lock").status, "ready");
});

test("malformed/uncorrelated input cannot change admission or echo arbitrary data", () => {
  const { runtime } = fixture();
  for (const line of ["{", "null", "[]", '{}', '{"id":0,"action":"lock"}', '{"id":"1","action":"lock"}', '{"id":1.5,"action":"lock"}', '{"id":9007199254740992,"action":"lock"}']) {
    assert.equal(handleMaintenanceLine(runtime, line), undefined);
    assert.equal(runtime.admission.isLocked(), false);
  }
  const reply = handleMaintenanceLine(runtime, '{"id":1,"action":"arbitrary-fs","credential":"private"}');
  assert.deepEqual(reply, { id: 1, status: "error" });
  assert.equal(JSON.stringify(reply).includes("private"), false);
  assert.equal(runtime.admission.isLocked(), false);
});

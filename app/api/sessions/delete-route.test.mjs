import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 业务在 session-service；本测试验证删除路由的委派与错误映射。
let deleted;
let failure;
const bareJiti = createJiti(import.meta.url);
const validateModule = await bareJiti.import("../../../lib/agent/protocol/validate.ts");
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@/lib/agent/protocol/validate": validateModule,
    "@/lib/rpc-manager": { getDefaultRuntime: () => "runtime" },
    "@/lib/agent/session-service": {
      deleteSession: async (id, runtime) => {
        if (failure) throw failure;
        deleted = [id, runtime];
      },
    },
  },
});
const { AgentProtocolError } = validateModule;
const { DELETE } = await jiti.import("./[id]/route.ts");
const remove = () => DELETE(new Request("http://localhost/api/sessions/id", { method: "DELETE" }), {
  params: Promise.resolve({ id: "id" }),
});

test("DELETE delegates to the session service with the runtime", async () => {
  deleted = undefined;
  failure = undefined;
  const response = await remove();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(deleted, ["id", "runtime"]);
});

test("missing sessions stay 404 and unexpected failures stay 500", async () => {
  failure = new AgentProtocolError("session_not_found", "Session not found: id");
  try {
    assert.equal((await remove()).status, 404);
  } finally {
    failure = undefined;
  }
  failure = new Error("unlink failed");
  try {
    const response = await remove();
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /unlink failed/);
  } finally {
    failure = undefined;
  }
});

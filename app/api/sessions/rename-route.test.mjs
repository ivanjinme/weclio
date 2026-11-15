import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 业务在 session-service；本测试验证路由参数解析与错误映射。
const calls = [];
let failure;
const bareJiti = createJiti(import.meta.url);
const validateModule = await bareJiti.import("../../../lib/agent/protocol/validate.ts");
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@/lib/agent/protocol/validate": validateModule,
    "@/lib/rpc-manager": { getDefaultRuntime: () => "runtime" },
    "@/lib/agent/session-service": {
      readSessionView: async (id, options) => {
        if (failure) throw failure;
        calls.push(["view", id, options]);
        return { sessionId: id, tree: [], context: { messages: [] } };
      },
      renameSession: async (id, name, runtime) => {
        if (failure) throw failure;
        calls.push(["rename", id, name, runtime]);
      },
    },
  },
});
const { AgentProtocolError } = validateModule;
const { GET, PATCH } = await jiti.import("./[id]/route.ts");

const params = { params: Promise.resolve({ id: "id" }) };
const get = (query = "") => GET(new Request(`http://localhost/api/sessions/id${query}`), params);
const patch = (body) => PATCH(new Request("http://localhost/api/sessions/id", { method: "PATCH", body: JSON.stringify(body) }), params);

test("GET forwards the deferred-render flags to the service", async () => {
  calls.length = 0;
  failure = undefined;
  const response = await get("?deferThinking&deferMedia");
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["view", "id", { deferThinking: true, deferToolResultImages: true }]]);
});

test("PATCH requires a string name and delegates the rename", async () => {
  calls.length = 0;
  failure = undefined;
  assert.equal((await patch({})).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await patch({ name: "Manual" })).status, 200);
  assert.deepEqual(calls, [["rename", "id", "Manual", "runtime"]]);
});

test("unknown sessions map to 404 and unexpected failures to 500", async () => {
  failure = new AgentProtocolError("session_not_found", "Session not found: id");
  try {
    assert.equal((await get()).status, 404);
  } finally {
    failure = undefined;
  }
  failure = new Error("boom");
  try {
    assert.equal((await get()).status, 500);
  } finally {
    failure = undefined;
  }
});

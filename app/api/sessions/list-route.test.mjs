import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 业务已迁移到 session-service；本测试只验证 HTTP 适配与错误映射。
let catalogCalls = 0;
let titleIds;
let titlesError;
const bareJiti = createJiti(import.meta.url);
const validateModule = await bareJiti.import("../../../lib/agent/protocol/validate.ts");
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@/lib/agent/protocol/validate": validateModule,
    "@/lib/rpc-manager": { getDefaultRuntime: () => "runtime" },
    "@/lib/agent/session-service": {
      listSessionCatalog: async (runtime) => {
        catalogCalls += 1;
        assert.equal(runtime, "runtime");
        return { sessions: [{ id: "thread" }], runningSessionIds: ["thread"] };
      },
      listSessionTitles: async (ids) => {
        if (titlesError) throw titlesError;
        titleIds = ids;
        return [{ id: ids[0], name: "Title" }];
      },
    },
  },
});
const { AgentProtocolError } = validateModule;
const { GET, POST } = await jiti.import("./route.ts");
const request = (body) => new Request("http://localhost/api/sessions", { method: "POST", body: JSON.stringify(body) });

test("GET returns the catalog from the session service", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessions: [{ id: "thread" }], runningSessionIds: ["thread"] });
  assert.ok(catalogCalls >= 1);
});

test("POST loads explicit title IDs", async () => {
  titlesError = undefined;
  const response = await POST(request({ ids: ["thread"] }));
  assert.equal(response.status, 200);
  assert.deepEqual(titleIds, ["thread"]);
  assert.deepEqual(await response.json(), { titles: [{ id: "thread", name: "Title" }] });
});

test("POST rejects malformed, non-string and oversized batches before calling the service", async () => {
  titleIds = undefined;
  for (const body of [null, {}, { ids: "thread" }, { ids: [42] }, { ids: Array(101).fill("id") }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400);
  assert.equal(titleIds, undefined);
});

test("service validation errors map to 400 instead of 500", async () => {
  titlesError = new AgentProtocolError("invalid_argument", "bad ids");
  try {
    assert.equal((await POST(request({ ids: ["thread"] }))).status, 400);
  } finally {
    titlesError = undefined;
  }
});

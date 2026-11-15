import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 模型配置读写、默认模型与连通性测试的参数校验；全部落在临时 agentDir。
const root = mkdtempSync(join(tmpdir(), "weclio-settings-service-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const jiti = createJiti(import.meta.url);
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const settings = await jiti.import("./settings-service.ts");
const { allowFileRoot } = await jiti.import("../file-access.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function reject(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const fixtureConfig = {
  providers: {
    "fixture-provider": {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/never-called",
      apiKey: "fixture-only-not-a-credential",
      models: [{ id: "fixture-model", name: "Fixture Model", input: ["text"], contextWindow: 4096, maxTokens: 256 }],
    },
  },
};

test("models config round-trips through the shared service", () => {
  settings.writeModelsConfig(fixtureConfig);
  assert.deepEqual(settings.readModelsConfig(), fixtureConfig);
  assert.equal(settings.modelsConfigPath(), join(agentDir, "models.json"));
});

test("malformed models config is rejected instead of silently replaced", () => {
  writeFileSync(settings.modelsConfigPath(), "{not json");
  assert.throws(() => settings.readModelsConfig());
  // 损坏文件不会被静默覆盖：清理后必须重新写入。
  rmSync(settings.modelsConfigPath());
  settings.writeModelsConfig(fixtureConfig);
});

test("default model is persisted to settings.json", async () => {
  await settings.setDefaultModel("fixture-provider", "fixture-model", workspace);
  const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.equal(saved.defaultProvider, "fixture-provider");
  assert.equal(saved.defaultModel, "fixture-model");
});

test("default model requires both provider and model id", async () => {
  await reject(settings.setDefaultModel("fixture-provider", undefined, workspace), "invalid_argument");
  await reject(settings.setDefaultModel(undefined, "fixture-model", workspace), "invalid_argument");
});

test("model listing includes configured providers and honors allowed roots", async () => {
  settings.writeModelsConfig(fixtureConfig);
  await reject(settings.listModels({ cwd: workspace, defaultWorkspace: workspace }), "forbidden");
  allowFileRoot(workspace);

  const listed = await settings.listModels({ cwd: workspace, defaultWorkspace: workspace });
  assert.ok(listed.modelList.some((model) => model.provider === "fixture-provider" && model.id === "fixture-model"));
  assert.deepEqual(listed.defaultModel, { provider: "fixture-provider", modelId: "fixture-model" });

  const draft = await settings.listModels({ defaultWorkspace: workspace });
  assert.ok(draft.modelList.some((model) => model.id === "fixture-model"));
  await reject(settings.listModels({ cwd: join(root, "missing"), defaultWorkspace: workspace }), "invalid_argument");
});

test("model test validates input and reports missing credentials without network", async () => {
  await reject(settings.testModel({}), "invalid_argument");
  await reject(settings.testModel({ providerName: "p" }), "invalid_argument");
  await reject(settings.testModel({ providerName: "p", provider: {}, model: {} }), "invalid_argument");

  const result = await settings.testModel({
    providerName: "fixture-provider",
    provider: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-called" },
    model: { id: "fixture-model" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /No API key/);
});

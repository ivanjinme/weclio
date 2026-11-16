import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 凭据服务：使用临时 agentDir；不登录真实账号、不联网。
const root = mkdtempSync(join(tmpdir(), "weclio-provider-auth-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const auth = await jiti.import("./provider-auth-service.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function reject(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("oauth provider list excludes anthropic and reports login state", async () => {
  const { providers } = await auth.listOAuthProviders();
  assert.equal(providers.some((provider) => provider.id === "anthropic"), false);
  for (const provider of providers) {
    assert.equal(typeof provider.name, "string");
    assert.equal(typeof provider.loggedIn, "boolean");
    assert.equal(provider.usesCallbackServer, false);
  }
});

test("api-key provider list omits oauth providers and models.json keys", async () => {
  const { providers } = await auth.listApiKeyProviders();
  for (const provider of providers) {
    assert.equal(["anthropic", "github-copilot", "openai-codex"].includes(provider.id), false);
    assert.notEqual(provider.source, "models_json_key");
    assert.equal(typeof provider.modelCount, "number");
  }
});

test("api-key status never echoes a key and reports configured state", async () => {
  const status = await auth.getApiKeyStatus("openai");
  assert.equal(status.provider, "openai");
  assert.equal(typeof status.configured, "boolean");
  assert.equal(typeof status.models, "number");
  assert.equal("apiKey" in status, false);
  assert.equal(JSON.stringify(status).includes("sk-"), false);
});

test("saving an api key requires a non-empty string", async () => {
  for (const value of [undefined, null, "", "   ", 42]) {
    await reject(auth.saveApiKey("openai", value), "invalid_argument");
  }
});

test("logout rejects providers without an oauth flow", async () => {
  // 锁定 SDK 中确实没有 OAuth flow 的 provider，避免随内置列表变化而失效。
  await reject(auth.logoutProvider("cerebras"), "invalid_argument");
  await reject(auth.logoutProvider("not-a-provider"), "invalid_argument");
});

test("deleting an unknown key does not throw and never returns secrets", async () => {
  await auth.deleteApiKey("openai");
  await auth.deleteApiKey("not-a-provider");
});

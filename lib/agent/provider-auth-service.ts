import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "../models-cache";
import { normalizeOptionalString } from "../models-config-import";
import { AgentProtocolError } from "./protocol/validate";

// Provider 凭据与模型刷新：只读写 Service 自己的 agentDir，不回传密钥明文。

const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);
const EXCLUDED_OAUTH_PROVIDERS = new Set(["anthropic"]);
const OAUTH_DISPLAY_NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT Plus/Pro",
  "github-copilot": "GitHub Copilot",
};

export interface OAuthProviderView {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

/** 走 OAuth 登录流程的 provider（登录本身是 SSE，A3.2 才迁入 Service）。 */
export async function listOAuthProviders(): Promise<{ providers: OAuthProviderView[] }> {
  const modelRuntime = await ModelRuntime.create();
  const credentials = await modelRuntime.listCredentials();
  const loggedIn = new Set(
    credentials.filter((credential) => credential.type === "oauth").map((credential) => credential.providerId),
  );
  const providers = modelRuntime.getProviders()
    .filter((provider) => provider.auth.oauth && !EXCLUDED_OAUTH_PROVIDERS.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: OAUTH_DISPLAY_NAMES[provider.id] ?? provider.name,
      usesCallbackServer: false,
      loggedIn: loggedIn.has(provider.id),
    }));
  return { providers };
}

export interface ApiKeyProviderView {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
}

/** 走 API key 的 provider；排除 OAuth provider 与 models.json 自带 key 的自定义 provider。 */
export async function listApiKeyProviders(): Promise<{ providers: ApiKeyProviderView[] }> {
  const modelRuntime = await ModelRuntime.create();
  const all = modelRuntime.getModels();
  const seen = new Set<string>();
  const providers: ApiKeyProviderView[] = [];

  for (const provider of modelRuntime.getProviders()) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    if (OAUTH_PROVIDER_IDS.has(provider.id) || !provider.auth.apiKey?.login) continue;
    const status = modelRuntime.getProviderAuthStatus(provider.id);
    if (status.source === "models_json_key") continue;
    providers.push({
      id: provider.id,
      displayName: provider.name,
      configured: status.configured,
      source: status.source,
      modelCount: all.filter((model) => model.provider === provider.id).length,
    });
  }
  return { providers };
}

export interface ApiKeyStatusView {
  provider: string;
  displayName: string;
  configured: boolean;
  source?: string;
  models: number;
}

/** 只返回是否已配置与来源，绝不返回密钥本身。 */
export async function getApiKeyStatus(provider: string): Promise<ApiKeyStatusView> {
  const modelRuntime = await ModelRuntime.create();
  const status = modelRuntime.getProviderAuthStatus(provider);
  return {
    provider,
    displayName: modelRuntime.getProvider(provider)?.name ?? provider,
    configured: status.configured,
    source: status.source,
    models: modelRuntime.getModels(provider).length,
  };
}

/**
 * 保存 API key。SDK 的 login 流程可能先要求选择认证方式，
 * 这里只接受 api-key/bearer-token 选项与一次 secret 输入，其余视为不支持。
 */
export async function saveApiKey(provider: string, apiKey: unknown): Promise<void> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new AgentProtocolError("invalid_argument", "apiKey is required");
  }
  const trimmed = apiKey.trim();
  const modelRuntime = await ModelRuntime.create();
  let keySubmitted = false;
  await modelRuntime.login(provider, "api_key", {
    notify: () => {},
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
        if (keyOption) return keyOption.id;
        throw new AgentProtocolError("command_failed", `${provider} requires interactive authentication setup`);
      }
      if (!keySubmitted && prompt.type === "secret") {
        keySubmitted = true;
        return trimmed;
      }
      throw new AgentProtocolError("command_failed", `${provider} requires additional authentication settings`);
    },
  });
  invalidateModelsCache();
}

export async function deleteApiKey(provider: string): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  await modelRuntime.logout(provider);
  invalidateModelsCache();
}

export async function logoutProvider(provider: string): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    throw new AgentProtocolError("invalid_argument", `Unknown provider: ${provider}`);
  }
  await modelRuntime.logout(provider);
  invalidateModelsCache();
}

export interface ProviderModelsView {
  provider: {
    api: string;
    baseUrl?: string;
    models: Array<Record<string, unknown> & { id: string; name: string }>;
  };
}

/** 联网刷新单个 provider 的模型清单；用于配置页导入。 */
export async function refreshProviderModels(providerId: string): Promise<ProviderModelsView> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    modelsPath: join(agentDir, ".models-defaults.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const refreshResult = await runtime.refresh({ providers: [providerId], allowNetwork: true, force: true });
  const refreshError = refreshResult.errors.get(providerId);
  if (refreshError) {
    throw new AgentProtocolError("bad_gateway", `Failed to refresh provider ${providerId}: ${refreshError.message}`);
  }

  const provider = runtime.getProvider(providerId);
  const models = runtime.getModels(providerId);
  if (!provider || models.length === 0) {
    throw new AgentProtocolError("not_found", `Provider not found: ${providerId}`);
  }

  const api = models[0].api;
  const baseUrl = normalizeOptionalString(provider.baseUrl ?? models[0].baseUrl);
  return {
    provider: {
      api,
      baseUrl,
      models: models.map((model) => {
        const modelBaseUrl = normalizeOptionalString(model.baseUrl);
        return {
          id: model.id,
          name: model.name,
          api: model.api === api ? undefined : model.api,
          baseUrl: modelBaseUrl === baseUrl ? undefined : modelBaseUrl,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: model.cost,
          samplingParams: model.samplingParams,
          headers: model.headers,
          compat: model.compat,
        };
      }),
    },
  };
}

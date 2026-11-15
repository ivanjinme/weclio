import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSessionServices, getAgentDir, ModelRuntime, SettingsManager, type SettingsManager as SettingsManagerType } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { invalidateModelsCache, loadModelsWithCache, withModelRuntimeError, type ModelsData } from "../models-cache";
import { readModelsJsonFile, writeModelsJsonFile } from "../models-config-file";
import { projectTrustReloadOptions } from "../project-trust";
import { AgentProtocolError } from "./protocol/validate";

// 模型与配置：列表、models.json 读写、默认模型与连通性测试；不依赖宿主。

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEST_TIMEOUT_MS = 20_000;

const EMPTY_MODELS: ModelsData = { models: {}, modelList: [], defaultModel: null, thinkingLevels: {} };

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): readonly T[] {
  if (!enabledModels || enabledModels.length === 0) return available;
  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter((model) => refs.has(`${model.provider}/${model.id}`) || refs.has(model.id));
  return visible.length > 0 ? visible : available;
}

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};

  const agentDir = getAgentDir();
  // 枚举模型也会 import 项目扩展工厂，因此同样受项目信任门控约束。
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const available = await services.modelRuntime.getAvailable();
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManagerType = services.settingsManager;
  const visible = filterByExactEnabledModels(available, settings.getEnabledModels());

  const modelList = visible.map((model: { id: string; name: string; provider: string }) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
  })).sort(compareModelEntries);
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap.set(key, model.name);
    thinkingLevels[key] = getSupportedThinkingLevels(model);
  }

  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const defaultModel = provider && modelId && visible.some((m) => m.provider === provider && m.id === modelId)
    ? { provider, modelId }
    : null;

  return withModelRuntimeError(
    { models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels },
    modelError,
  );
}

export interface ListModelsOptions {
  /** 客户端指定工作区；为空表示无项目的草稿输入框。 */
  cwd?: string | null;
  /** Service 自己的默认工作区，用于无 cwd 请求。 */
  defaultWorkspace: string;
}

export async function listModels(options: ListModelsOptions): Promise<ModelsData> {
  const requested = options.cwd?.trim() || undefined;
  const cwd = resolve(requested ?? options.defaultWorkspace);

  if (requested) {
    let status;
    try {
      status = await stat(cwd);
    } catch {
      throw new AgentProtocolError("invalid_argument", `Directory does not exist: ${cwd}`);
    }
    if (!status.isDirectory()) throw new AgentProtocolError("invalid_argument", `Not a directory: ${cwd}`);
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  }

  try {
    return await loadModelsWithCache(cwd, () => loadModels(cwd));
  } catch {
    return EMPTY_MODELS;
  }
}

export function modelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

export function readModelsConfig(): unknown {
  return readModelsJsonFile(modelsConfigPath());
}

export function writeModelsConfig(body: unknown): void {
  writeModelsJsonFile(modelsConfigPath(), body);
  invalidateModelsCache();
}

/** 记住用户最后选择的模型为全局默认，供新会话使用。 */
export async function setDefaultModel(provider: unknown, modelId: unknown, defaultWorkspace: string): Promise<void> {
  if (typeof provider !== "string" || typeof modelId !== "string") {
    throw new AgentProtocolError("invalid_argument", "provider and modelId are required");
  }
  const settingsManager = SettingsManager.create(defaultWorkspace, getAgentDir(), { projectTrusted: false });
  settingsManager.setDefaultModelAndProvider(provider, modelId);
  await settingsManager.flush();
  invalidateModelsCache();
}

export interface ModelTestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  responseText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/**
 * 连通性测试：临时 models.json + 一次最小请求。
 * 业务失败（无 key、超时、模型报错）以 ok:false 返回，参数错误才抛协议错误。
 */
export async function testModel(body: unknown): Promise<ModelTestResult> {
  const payload = (body ?? {}) as { providerName?: unknown; provider?: unknown; model?: unknown };
  const providerName = typeof payload.providerName === "string" ? payload.providerName.trim() : "";
  if (!providerName) throw new AgentProtocolError("invalid_argument", "providerName is required");
  if (!isRecord(payload.provider)) throw new AgentProtocolError("invalid_argument", "provider is required");
  if (!isRecord(payload.model)) throw new AgentProtocolError("invalid_argument", "model is required");
  const modelId = typeof payload.model.id === "string" ? payload.model.id.trim() : "";
  if (!modelId) throw new AgentProtocolError("invalid_argument", "Model ID is required");

  const tempDir = mkdtempSync(join(tmpdir(), "weclio-model-test-"));
  try {
    const modelsPath = join(tempDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: { [providerName]: { ...payload.provider, models: [{ ...payload.model, id: modelId }] } },
    }, null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) return { ok: false, error: loadError };

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) return { ok: false, error: `No API key found for "${providerName}"` };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();
    try {
      // 测试不生成推理控制参数，也不修改保存的模型能力。
      const message = await completeSimple({ ...model, reasoning: false }, {
        messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return {
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
        };
      }
      return { ok: true, latencyMs, status, responseText: getAssistantText(message).slice(0, 300) };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

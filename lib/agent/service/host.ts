import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync, watch, writeFileSync, type Stats } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "../../rpc-manager";
import { statusForProtocolCode } from "../protocol/http-status";
import { fileIndex } from "../file-index-service";
import {
  downloadMime,
  fileResponseHeaders,
  listDirectory,
  parseByteRange,
  parseFileRequestType,
  readBinaryMime,
  readFileMeta,
  readTextFile,
  renderDocumentPreview,
  resolveFileTarget,
  writeTextFile,
  resolveUploadDirectory,
} from "../files-service";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  replaceUploadFile,
  validateUploadFileNames,
} from "../../file-upload";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "../../bounded-form-data";
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
} from "../files-service";
import { gitDiff, gitStatus } from "../git-service";
import { listModels, readModelsConfig, setDefaultModel, testModel, writeModelsConfig } from "../settings-service";
import {
  deleteApiKey,
  getApiKeyStatus,
  listApiKeyProviders,
  listOAuthProviders,
  logoutProvider,
  refreshProviderModels,
  saveApiKey,
} from "../provider-auth-service";
import { getCodexUsage } from "../../codex-usage";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "../../bash-output";
import { isBashOutputPathReferencedBySession } from "../../session-file-references";
import { subscribeSessionListChanges } from "../../session-reader";
import { listPlugins, mutatePlugins, type PluginMutationInput } from "../plugins-service";
import { checkUpdates, installSkill, listSkills, searchSkills, setSkillModelInvocation, updateSkill } from "../skill-actions-service";
import { openSessionEventStream, parseLastEventId } from "../session-events";
import type { OAuthClientEvent } from "../oauth-login-service";
import { createOAuthLoginManager } from "../oauth-login-service";
import {
  browseWorkspace,
  ensureWorkspace,
  getHomeDirectory,
  grantProjectTrust,
  listPins,
  readProjectTrust,
  rebindProject,
  setPinned,
  validateWorkspace,
} from "../workspace-service";
import {
  autoNameSession,
  deleteSession,
  listSessionCatalog,
  listSessionTitles,
  readSessionContext,
  readSessionRuntimeState,
  readSessionView,
  readThinkingBlock,
  renameSession,
} from "../session-service";
import { AgentProtocolError, parseAgentCommand, type AgentProtocolErrorCode } from "../protocol/validate";
import { PROTOCOL_VERSION } from "../protocol/version";
import type { ServiceConfig } from "./config";

const MAX_BODY_BYTES = 1024 * 1024;
const COMMANDS_ROUTE = /^\/v1\/sessions\/([^/]+)\/commands$/;
const SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)$/;
const SESSION_STATE_ROUTE = /^\/v1\/sessions\/([^/]+)\/state$/;

export interface AgentServiceHostOptions {
  runtime: AgentRuntime;
  config: ServiceConfig;
  serviceId: string;
  instanceId: string;
  appVersion: string;
}

export interface AgentServiceHost {
  url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-request-id": requestId,
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: AgentProtocolErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, { success: false, error: { code, message, requestId, ...details } }, requestId);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AgentProtocolError("payload_too_large", "Request body is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** 额外允许的来源（如静态 UI 的 weclio://app 或未来的 Web 源），逗号分隔。 */
function configuredOrigins(): string[] {
  return (process.env.WECLIO_AGENT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAllowedOrigin(req: IncomingMessage, allowed = configuredOrigins()): boolean {
  const origin = req.headers.origin;
  // 浏览器跨源必须显式允许；本机客户端不带 Origin。
  if (origin === undefined || origin === "null") return true;
  if (origin === `http://${req.headers.host}`) return true;
  return allowed.includes(origin);
}

const MAX_TEXT_WRITE_BYTES = 8 * 1024 * 1024;

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
    method: req.method ?? "POST",
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function readLimitedBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AgentProtocolError("payload_too_large", "Request body is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** 单段 Range 流式响应；非法区间返回 416 并带总长度。 */
function sendFileStream(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  stat: Stats,
  contentType: string,
  asDownload: boolean,
): void {
  const headers = fileResponseHeaders(filePath, contentType, asDownload);
  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
    createReadStream(filePath).pipe(res);
    return;
  }

  const range = parseByteRange(rangeHeader, stat.size);
  if (range === "invalid" || range === null) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const length = range.end - range.start + 1;
  res.writeHead(206, {
    ...headers,
    "Content-Length": String(length),
    "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
  });
  createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
}

function sendFileWatch(res: ServerResponse, filePath: string, stat: Stats): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (eventName: string, data: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let lastMtimeMs = stat.mtimeMs;
  let lastSize = stat.size;
  send("connected", { filePath, mtime: stat.mtime.toISOString(), size: stat.size });

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(filePath, () => {
      try {
        const next = statSync(filePath);
        // 某些平台读文件也会触发事件；忽略未变化的状态，避免客户端刷新循环。
        if (next.mtimeMs === lastMtimeMs && next.size === lastSize) return;
        lastMtimeMs = next.mtimeMs;
        lastSize = next.size;
        send("change", { mtime: next.mtime.toISOString(), size: next.size });
      } catch {
        send("change", { mtime: new Date().toISOString(), size: 0 });
      }
    });
    watcher.on("error", () => { try { res.end(); } catch { /* 已断开 */ } });
  } catch {
    send("error", { message: "Failed to watch file" });
  }
  res.on("close", () => {
    try { watcher?.close(); } catch { /* 已关闭 */ }
  });
}

export async function startAgentServiceHost(options: AgentServiceHostOptions): Promise<AgentServiceHost> {
  const { runtime, config } = options;
  // 每个 Service 实例自己的 OAuth 登录状态：不跨实例共享挂起会话。
  const oauthLogins = createOAuthLoginManager();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const requestId = randomUUID();
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AgentProtocolError) {
        sendError(res, statusForProtocolCode(error.code), error.code, message, requestId);
        return;
      }
      sendError(res, 500, "command_failed", message, requestId);
      console.error("[agent-service] request failed:", message);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    // 最小活性检查：不返回路径、版本或配置。
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" }, requestId);
      return;
    }

    // 跨源浏览器客户端（静态 UI / 本地 dev）需要 CORS 与预检；Origin 白名单仍未放宽。
    const origin = req.headers.origin;
    const corsAllowed = origin !== undefined && isAllowedOrigin(req);
    if (corsAllowed) {
      res.setHeader("access-control-allow-origin", origin!);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("access-control-max-age", "600");
    }

    if (method === "OPTIONS") {
      if (!corsAllowed) {
        sendError(res, 403, "forbidden_origin", "Cross-origin requests are not allowed", requestId);
        return;
      }
      res.writeHead(204, { "x-request-id": requestId });
      res.end();
      return;
    }

    const business = url.pathname.startsWith("/v1/");
    if (business) {
      if (!authorized(req, config.token)) {
        sendError(res, 401, "unauthorized", "Missing or invalid service token", requestId);
        return;
      }
      if (!isAllowedOrigin(req)) {
        sendError(res, 403, "forbidden_origin", "Cross-origin requests are not allowed", requestId);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/v1/info") {
      sendJson(res, 200, {
        serviceId: options.serviceId,
        instanceId: options.instanceId,
        protocol: { version: PROTOCOL_VERSION, minClient: PROTOCOL_VERSION },
        app: { version: options.appVersion },
        capabilities: ["commands"],
      }, requestId);
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/v1/files/")) {
      const segments = url.pathname.slice("/v1/files/".length).split("/").map(decodeURIComponent);
      const directory = await resolveUploadDirectory(segments);
      const type = url.searchParams.get("type") ?? "upload";

      if (type === "upload-check") {
        const body = JSON.parse(await readBody(req)) as { fileNames?: unknown };
        if (!Array.isArray(body.fileNames) || !body.fileNames.every((item) => typeof item === "string")) {
          throw new AgentProtocolError("invalid_argument", "fileNames must be an array of strings");
        }
        const fileNames = body.fileNames as string[];
        const validationError = validateUploadFileNames(fileNames);
        if (validationError) throw new AgentProtocolError("invalid_argument", validationError);
        sendJson(res, 200, inspectUploadTargets(directory, fileNames), requestId);
        return;
      }
      if (type !== "upload") throw new AgentProtocolError("invalid_argument", "Invalid upload request type");

      const strategy = parseUploadConflictStrategy(url.searchParams.get("conflict"));
      if (!strategy) throw new AgentProtocolError("invalid_argument", "Invalid conflict strategy");

      let formData: FormData;
      try {
        formData = await parseFormDataWithinLimit(toWebRequest(req), MAX_UPLOAD_REQUEST_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          throw new AgentProtocolError("payload_too_large", "Uploads must total 100MB or less");
        }
        throw error;
      }
      const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
      if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
        throw new AgentProtocolError("payload_too_large", "Each upload must be 25MB or smaller");
      }
      if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
        throw new AgentProtocolError("payload_too_large", "Uploads must total 100MB or less");
      }
      const fileNames = files.map((file) => file.name);
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) throw new AgentProtocolError("invalid_argument", validationError);

      const inspection = inspectUploadTargets(directory, fileNames);
      if (strategy === "error" && inspection.conflicts.length > 0) {
        sendError(res, 409, "conflict", "One or more files already exist", requestId, {
          conflicts: inspection.conflicts,
          nonReplaceable: inspection.nonReplaceable,
        });
        return;
      }

      const conflictSet = new Set(inspection.conflicts);
      const nonReplaceableSet = new Set(inspection.nonReplaceable);
      const uploaded: string[] = [];
      const skipped: string[] = [];
      const failures: Array<{ name: string; error: string }> = [];
      for (const file of files) {
        if (conflictSet.has(file.name) && strategy === "skip") {
          skipped.push(file.name);
          continue;
        }
        if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
          failures.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await file.arrayBuffer());
        } catch (error) {
          failures.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        try {
          if (conflictSet.has(file.name)) replaceUploadFile(path.join(directory, file.name), bytes);
          else writeFileSync(path.join(directory, file.name), bytes, { flag: "wx" });
          uploaded.push(file.name);
        } catch (error) {
          failures.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const payload = { uploaded, skipped, errors: failures };
      if (failures.length > 0) sendJson(res, 207, payload, requestId);
      else sendJson(res, 200, payload, requestId);
      return;
    }

    // /v1/files/index 是索引查询，不能当作文件名解析。
    if (url.pathname.startsWith("/v1/files/") && url.pathname !== "/v1/files/index") {
      const segments = url.pathname.slice("/v1/files/".length).split("/").map(decodeURIComponent);

      if (method === "PUT") {
        const target = await resolveFileTarget(segments, "read");
        const bytes = await readLimitedBody(req, MAX_TEXT_WRITE_BYTES);
        sendJson(res, 200, { size: writeTextFile(target.filePath, target.allowedRoots, bytes) }, requestId);
        return;
      }

      if (method === "GET") {
        const type = parseFileRequestType(url.searchParams.get("type") ?? "list");
        if (!type) throw new AgentProtocolError("invalid_argument", "Invalid file request type");
        const target = await resolveFileTarget(segments, type, url.searchParams.get("sessionId"));
        const { filePath, stat, allowedRoots } = target;

        if (type === "list") {
          if (!stat.isDirectory()) throw new AgentProtocolError("invalid_argument", "Not a directory");
          sendJson(res, 200, { entries: listDirectory(filePath), path: filePath }, requestId);
          return;
        }
        if (type === "read") {
          const binaryMime = readBinaryMime(filePath, stat);
          if (binaryMime) {
            sendFileStream(req, res, filePath, stat, binaryMime, false);
            return;
          }
          sendJson(res, 200, readTextFile(filePath, stat, allowedRoots), requestId);
          return;
        }
        if (type === "download") {
          sendFileStream(req, res, filePath, stat, downloadMime(filePath), true);
          return;
        }
        if (type === "meta") {
          sendJson(res, 200, readFileMeta(filePath, stat, allowedRoots), requestId);
          return;
        }
        if (type === "preview") {
          const html = await renderDocumentPreview(filePath, stat);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
            "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-request-id": requestId,
          });
          res.end(html);
          return;
        }
        sendFileWatch(res, filePath, stat);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/v1/git/status") {
      sendJson(res, 200, await gitStatus(url.searchParams.get("cwd")), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/git/diff") {
      sendJson(res, 200, await gitDiff(url.searchParams.get("cwd"), url.searchParams.get("path")), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/files/index") {
      sendJson(res, 200, await fileIndex(url.searchParams.get("cwd"), url.searchParams.get("q")), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/home") {
      sendJson(res, 200, { home: getHomeDirectory() }, requestId);
      return;
    }

    if (url.pathname === "/v1/workspaces/default") {
      if (method === "GET") {
        sendJson(res, 200, { cwd: config.workspace }, requestId);
        return;
      }
      if (method === "POST") {
        sendJson(res, 200, { cwd: ensureWorkspace(config.workspace) }, requestId);
        return;
      }
    }

    if (method === "POST" && url.pathname === "/v1/workspaces/validate") {
      const body = JSON.parse(await readBody(req)) as { cwd?: unknown };
      const { cwd } = validateWorkspace(body.cwd);
      sendJson(res, 200, { success: true, cwd }, requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/workspaces/browse") {
      sendJson(res, 200, await browseWorkspace(url.searchParams.get("path")), requestId);
      return;
    }

    if (url.pathname === "/v1/projects/trust") {
      if (method === "GET") {
        sendJson(res, 200, await readProjectTrust(url.searchParams.get("cwd")), requestId);
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(await readBody(req)) as { cwd?: unknown };
        sendJson(res, 200, await grantProjectTrust(body.cwd, runtime), requestId);
        return;
      }
    }

    if (method === "POST" && url.pathname === "/v1/projects/rebind") {
      const body = JSON.parse(await readBody(req)) as { oldRoot?: unknown; newRoot?: unknown };
      sendJson(res, 200, await rebindProject(body, runtime), requestId);
      return;
    }

    const loginRoute = /^\/v1\/provider-auth\/login\/([^/]+)$/.exec(url.pathname);
    if (loginRoute) {
      const provider = decodeURIComponent(loginRoute[1]);
      if (method === "POST") {
        const body = JSON.parse(await readBody(req)) as { token?: unknown; code?: unknown };
        if (typeof body.token !== "string" || typeof body.code !== "string") {
          throw new AgentProtocolError("invalid_argument", "token and code required");
        }
        oauthLogins.submit(body.token, body.code);
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }
      if (method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-request-id": requestId,
        });
        const handle = oauthLogins.start(provider, (event: OAuthClientEvent) => {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(event) + "\n\n");
        });
        const finish = () => { try { res.end(); } catch { /* 已结束 */ } };
        res.on("close", () => handle.abort());
        void handle.done.finally(finish);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/v1/provider-auth/oauth") {
      sendJson(res, 200, await listOAuthProviders(), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/provider-auth/providers") {
      sendJson(res, 200, await listApiKeyProviders(), requestId);
      return;
    }

    const apiKeyProvider = /^\/v1\/provider-auth\/api-key\/([^/]+)$/.exec(url.pathname);
    if (apiKeyProvider) {
      const provider = decodeURIComponent(apiKeyProvider[1]);
      if (method === "GET") {
        sendJson(res, 200, await getApiKeyStatus(provider), requestId);
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(await readBody(req)) as { apiKey?: unknown };
        await saveApiKey(provider, body.apiKey);
        sendJson(res, 200, { success: true }, requestId);
        return;
      }
      if (method === "DELETE") {
        await deleteApiKey(provider);
        sendJson(res, 200, { success: true }, requestId);
        return;
      }
    }

    const providerLogout = /^\/v1\/provider-auth\/logout\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && providerLogout) {
      await logoutProvider(decodeURIComponent(providerLogout[1]));
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    const providerModels = /^\/v1\/settings\/models\/providers\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && providerModels) {
      sendJson(res, 200, await refreshProviderModels(decodeURIComponent(providerModels[1])), requestId);
      return;
    }

    if (url.pathname === "/v1/skills") {
      if (method === "GET") {
        sendJson(res, 200, await listSkills({
          cwd: url.searchParams.get("cwd"),
          globalOnly: url.searchParams.get("global") === "true",
        }), requestId);
        return;
      }
      if (method === "PATCH") {
        await setSkillModelInvocation(JSON.parse(await readBody(req)));
        sendJson(res, 200, { success: true }, requestId);
        return;
      }
    }

    if (method === "POST" && url.pathname === "/v1/skills/check") {
      sendJson(res, 200, await checkUpdates(JSON.parse(await readBody(req))), requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/skills/search") {
      sendJson(res, 200, await searchSkills(JSON.parse(await readBody(req))), requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/skills/install") {
      sendJson(res, 200, await installSkill(JSON.parse(await readBody(req)), () => runtime.reserveTask()), requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/skills/update") {
      sendJson(res, 200, await updateSkill(JSON.parse(await readBody(req)), () => runtime.reserveTask()), requestId);
      return;
    }

    if (url.pathname === "/v1/plugins") {
      if (method === "GET") {
        sendJson(res, 200, await listPlugins({
          cwd: url.searchParams.get("cwd"),
          globalOnly: url.searchParams.get("global") === "true",
        }), requestId);
        return;
      }
      if (method === "POST") {
        sendJson(res, 200, await mutatePlugins(JSON.parse(await readBody(req)) as PluginMutationInput), requestId);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/v1/usage/codex") {
      sendJson(res, 200, await getCodexUsage(), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, await listModels({
        cwd: url.searchParams.get("cwd"),
        defaultWorkspace: config.workspace,
      }), requestId);
      return;
    }

    if (url.pathname === "/v1/settings/models") {
      if (method === "GET") {
        sendJson(res, 200, readModelsConfig(), requestId);
        return;
      }
      if (method === "PUT") {
        writeModelsConfig(JSON.parse(await readBody(req)));
        sendJson(res, 200, { success: true }, requestId);
        return;
      }
    }

    if (method === "PUT" && url.pathname === "/v1/settings/models/default") {
      const body = JSON.parse(await readBody(req)) as { provider?: unknown; modelId?: unknown };
      await setDefaultModel(body.provider, body.modelId, config.workspace);
      sendJson(res, 200, { success: true }, requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/settings/models/test") {
      sendJson(res, 200, await testModel(JSON.parse(await readBody(req))), requestId);
      return;
    }

    if (url.pathname === "/v1/settings/pins") {
      if (method === "GET") {
        sendJson(res, 200, { pins: listPins() }, requestId);
        return;
      }
      if (method === "PATCH") {
        const body = JSON.parse(await readBody(req)) as { type?: unknown; id?: unknown; pinned?: unknown };
        if (typeof body.id !== "string" || typeof body.pinned !== "boolean") {
          throw new AgentProtocolError("invalid_argument", "type, id and pinned are required");
        }
        sendJson(res, 200, { pins: setPinned(body.type as "project" | "session", body.id, body.pinned) }, requestId);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/v1/sessions") {
      sendJson(res, 200, await listSessionCatalog(runtime), requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sessions/titles") {
      const body = JSON.parse(await readBody(req)) as { ids?: unknown };
      sendJson(res, 200, { titles: await listSessionTitles(body.ids as string[]) }, requestId);
      return;
    }

    // 运行态全局流：与 Next 侧同语义，先订阅后快照。
    if (method === "GET" && url.pathname === "/v1/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": requestId,
      });
      const write = (payload: unknown) => {
        if (res.writableEnded) return;
        res.write("data: " + JSON.stringify(payload) + "\n\n");
      };
      const unsubscribe = runtime.subscribeRunning((ids) => write({ type: "running", runningSessionIds: ids }));
      const unsubscribeChanges = subscribeSessionListChanges(() => write({ type: "sessions_changed" }));
      write({ type: "running", runningSessionIds: runtime.runningIds() });
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(":\n\n"); }, 30_000);
      heartbeat.unref?.();
      res.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeChanges();
      });
      return;
    }

    const contextRoute = /^\/v1\/sessions\/([^/]+)\/context$/.exec(url.pathname);
    if (method === "GET" && contextRoute) {
      sendJson(res, 200, {
        context: await readSessionContext(decodeURIComponent(contextRoute[1]), {
          leafId: url.searchParams.get("leafId"),
          deferThinking: url.searchParams.has("deferThinking"),
          deferToolResultImages: url.searchParams.has("deferMedia"),
        }),
      }, requestId);
      return;
    }

    const thinkingRoute = /^\/v1\/sessions\/([^/]+)\/entries\/([^/]+)\/thinking$/.exec(url.pathname);
    if (method === "GET" && thinkingRoute) {
      sendJson(res, 200, {
        thinking: await readThinkingBlock(
          decodeURIComponent(thinkingRoute[1]),
          decodeURIComponent(thinkingRoute[2]),
          url.searchParams.get("blockIndex") ?? Number.NaN,
        ),
      }, requestId);
      return;
    }

    const autoNameRoute = /^\/v1\/sessions\/([^/]+)\/auto-name$/.exec(url.pathname);
    if (method === "POST" && autoNameRoute) {
      sendJson(res, 200, await autoNameSession(decodeURIComponent(autoNameRoute[1]), runtime), requestId);
      return;
    }

    const bashOutputRoute = /^\/v1\/sessions\/([^/]+)\/bash-output$/.exec(url.pathname);
    if (method === "GET" && bashOutputRoute) {
      const sessionId = decodeURIComponent(bashOutputRoute[1]);
      const requested = url.searchParams.get("path");
      if (!requested) throw new AgentProtocolError("invalid_argument", "path required");
      const resolved = resolveBashOutputPath(requested, tmpdir());
      if (!resolved) throw new AgentProtocolError("invalid_argument", "invalid path");
      // 只有该会话记录过的输出文件可读。
      if (!await isBashOutputPathReferencedBySession(resolved, sessionId)) {
        throw new AgentProtocolError("forbidden", "forbidden");
      }
      if (url.searchParams.get("download") === "1") {
        const { handle } = await openRegularFileNoFollow(resolved);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": "attachment; filename=\"bash-output.log\"",
          "cache-control": "no-store",
          "x-request-id": requestId,
        });
        Readable.fromWeb(handle.createReadStream() as never).pipe(res);
        return;
      }
      const result = await readUtf8FileWithinLimit(resolved);
      if (result.tooLarge) {
        throw new AgentProtocolError("payload_too_large", "Full output is too large to display (limit " + MAX_INLINE_BASH_OUTPUT_BYTES + " bytes)");
      }
      sendJson(res, 200, { success: true, data: { output: result.content } }, requestId);
      return;
    }

    const eventsRoute = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (method === "GET" && eventsRoute) {
      const sessionId = decodeURIComponent(eventsRoute[1]);
      const cwd = url.searchParams.get("cwd") ?? config.workspace;
      const existing = runtime.getSession(sessionId);
      const { session } = existing?.isAlive()
        ? { session: existing }
        : await runtime.startSession(sessionId, "", cwd);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": requestId,
      });
      // 建议客户端 1s 后重连，避免 EventSource 默认的长退避。
      res.write("retry: 1000" + "\n\n");

      const stream = openSessionEventStream(
        session,
        (event) => {
          if (res.writableEnded) return;
          res.write("id: " + event.seq + "\n" + "data: " + JSON.stringify(event) + "\n\n");
        },
        {
          lastEventId: parseLastEventId(req.headers["last-event-id"] as string | undefined),
          onHeartbeat: () => { if (!res.writableEnded) res.write(":" + "\n\n"); },
        },
      );
      // 断开只释放订阅：Agent 继续执行，重连时以新快照对账。
      res.on("close", () => stream.close());
      return;
    }

    const state = SESSION_STATE_ROUTE.exec(url.pathname);
    if (method === "GET" && state) {
      sendJson(res, 200, await readSessionRuntimeState(decodeURIComponent(state[1]), runtime), requestId);
      return;
    }

    const session = SESSION_ROUTE.exec(url.pathname);
    if (session) {
      const sessionId = decodeURIComponent(session[1]);
      if (method === "GET") {
        sendJson(res, 200, await readSessionView(sessionId, {
          deferThinking: url.searchParams.has("deferThinking"),
          deferToolResultImages: url.searchParams.has("deferMedia"),
        }), requestId);
        return;
      }
      if (method === "PATCH") {
        const body = JSON.parse(await readBody(req)) as { name?: unknown };
        if (typeof body.name !== "string") throw new AgentProtocolError("invalid_argument", "name is required");
        await renameSession(sessionId, body.name, runtime);
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }
      if (method === "DELETE") {
        await deleteSession(sessionId, runtime);
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }
    }

    const commands = COMMANDS_ROUTE.exec(url.pathname);
    if (method === "POST" && commands) {
      const sessionId = decodeURIComponent(commands[1]);
      const cwd = url.searchParams.get("cwd") ?? config.workspace;
      try {
        const command = parseAgentCommand(JSON.parse(await readBody(req)));
        const existing = runtime.getSession(sessionId);
        const { session } = existing?.isAlive() ? { session: existing } : await runtime.startSession(sessionId, "", cwd);
        const result = await session.send(command);
        sendJson(res, 200, { success: true, data: result }, requestId);
      } catch (error) {
        if (error instanceof AgentProtocolError) {
          sendError(res, statusForProtocolCode(error.code), error.code, error.message, requestId);
          return;
        }
        sendError(res, 400, "invalid_argument", error instanceof Error ? error.message : String(error), requestId);
      }
      return;
    }

    sendError(res, 404, "not_found", `No route for ${method} ${url.pathname}`, requestId);
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${config.host === "localhost" ? "127.0.0.1" : config.host}:${address.port}`;

  return {
    url,
    async close() {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}

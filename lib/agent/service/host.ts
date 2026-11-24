import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync, watch, writeFileSync, type Stats } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "../../rpc-manager";
import { normalizeFilePathSlashes } from "../../file-paths";
import { FileWriteError, readTextBody } from "../../file-write";
import { statusForProtocolCode } from "../protocol/http-status";
import { createSession, resumeSession } from "../session-create-service";
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
  validateDocumentPreview,
  isWindowsAbsoluteFilePath,
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
  selectProject,
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
import { createResourceTicketSigner, type ResourceTicketResource } from "../resource-ticket";

const MAX_BODY_BYTES = 1024 * 1024;
// Chromium/Firefox 拒绝的端口；自动选择端口时不能落在这些值上。
const BROWSER_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

export function isBrowserBlockedPort(port: number): boolean {
  return BROWSER_BLOCKED_PORTS.has(port);
}

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

async function readObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    throw new AgentProtocolError("invalid_argument", "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentProtocolError("invalid_argument", "JSON body must be an object");
  }
  return body as Record<string, unknown>;
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

/** 单段 Range 流式响应；非法区间返回 416 并带总长度。 */
async function sendFileStream(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  stat: Stats,
  contentType: string,
  asDownload: boolean,
  resourceTicket = false,
  handle?: FileHandle,
): Promise<void> {
  try {
    const headers = fileResponseHeaders(filePath, contentType, asDownload);
    if (resourceTicket) headers["Cache-Control"] = "no-store";
    const rangeHeader = req.method === "GET" ? req.headers.range : undefined;
    const range = rangeHeader ? parseByteRange(rangeHeader, stat.size) : null;
    if (rangeHeader && (range === "invalid" || range === null)) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}`, "Content-Length": "0" });
      res.end();
      return;
    }
    const bounds = range && range !== "invalid" ? range : undefined;
    res.writeHead(bounds ? 206 : 200, {
      ...headers,
      "Content-Length": String(bounds ? bounds.end - bounds.start + 1 : stat.size),
      ...(bounds ? { "Content-Range": `bytes ${bounds.start}-${bounds.end}/${stat.size}` } : {}),
    });
    if (req.method === "HEAD") { res.end(); return; }
    const source = handle ? handle.createReadStream(bounds) : createReadStream(filePath, bounds);
    const close = () => source.destroy();
    res.once("close", close);
    try { await pipeline(source, res); } finally { res.off("close", close); }
  } finally {
    // HEAD、416、流错误和客户端断开都必须释放预先打开的描述符。
    await handle?.close();
  }
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
  const resourceTickets = createResourceTicketSigner(options.instanceId);
  const allowedOrigins = configuredOrigins();
  // CSP 来源只能是完整受信任源，不能把通配符或指令注入 frame-ancestors。
  const frameOrigins = allowedOrigins.filter((origin) => {
    try {
      const parsed = new URL(origin);
      return /^[a-z][a-z0-9+.-]*:\/\/[^\s;'"*]+$/i.test(origin)
        && !parsed.username && !parsed.password && (parsed.pathname === "" || parsed.pathname === "/")
        && !parsed.search && !parsed.hash;
    } catch { return false; }
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const requestId = randomUUID();
      const resourceRoute = req.url?.split("?")[0]?.startsWith("/v1/resources/");
      const message = resourceRoute && !(error instanceof AgentProtocolError)
        ? "Resource request failed" : error instanceof Error ? error.message : String(error);
      if (error instanceof AgentProtocolError) {
        sendError(res, statusForProtocolCode(error.code), error.code, message, requestId);
        return;
      }
      sendError(res, 500, "command_failed", message, requestId);
      if (!resourceRoute) console.error("[agent-service] request failed:", message);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    const resourceRoute = url.pathname.startsWith("/v1/resources/");
    const ticketContent = url.pathname === "/v1/resources/content" && (method === "GET" || method === "HEAD");
    if (resourceRoute) {
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
    }

    // 最小活性检查：不返回路径、版本或配置。
    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" }, requestId);
      return;
    }

    // 跨源浏览器客户端（静态 UI / 本地 dev）需要 CORS 与预检；Origin 白名单仍未放宽。
    const origin = req.headers.origin;
    const corsAllowed = origin !== undefined && isAllowedOrigin(req, allowedOrigins);
    if (corsAllowed) {
      res.setHeader("access-control-allow-origin", origin!);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
      res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
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
      if (!ticketContent && !authorized(req, config.token)) {
        sendError(res, 401, "unauthorized", "Missing or invalid service token", requestId);
        return;
      }
      if (!isAllowedOrigin(req, allowedOrigins)) {
        sendError(res, 403, "forbidden_origin", "Cross-origin requests are not allowed", requestId);
        return;
      }
    }

    // 统一覆盖文件、配置、认证和会话写入；只读流不持有维护门禁。
    const readOnlyPost = ["/v1/resources/tickets", "/v1/workspaces/validate", "/v1/sessions/titles"].includes(url.pathname);
    const writes = business && ((["POST", "PUT", "PATCH", "DELETE"].includes(method) && !(method === "POST" && readOnlyPost)) ||
      (method === "GET" && /^\/v1\/provider-auth\/login\/[^/]+$/.test(url.pathname)));
    if (writes && runtime.admission.isLocked()) {
      sendError(res, 503, "command_failed", "Service maintenance in progress; please try again later", requestId);
      return;
    }
    const release = writes ? runtime.reserveTask() : undefined;
    try { await handleBusiness(req, res, requestId, method, url); }
    finally { release?.(); }
  }

  async function handleBusiness(req: IncomingMessage, res: ServerResponse, requestId: string, method: string, url: URL): Promise<void> {
    const ticketContent = url.pathname === "/v1/resources/content" && (method === "GET" || method === "HEAD");
    if (method === "POST" && url.pathname === "/v1/resources/tickets") {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch (error) {
        if (error instanceof AgentProtocolError) throw error;
        throw new AgentProtocolError("invalid_argument", "Invalid resource request");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new AgentProtocolError("invalid_argument", "Invalid resource request");
      }
      const input = body as Record<string, unknown>;
      if (typeof input.filePath !== "string" || !input.filePath
        || (!path.isAbsolute(input.filePath) && !isWindowsAbsoluteFilePath(input.filePath))
        || typeof input.kind !== "string" || !["read", "preview", "download"].includes(input.kind)
        || (input.sessionId !== undefined && input.sessionId !== null && typeof input.sessionId !== "string")
        || (input.source !== undefined && input.source !== "bash-output")
        || (input.source === "bash-output" && (input.kind !== "download" || typeof input.sessionId !== "string" || !input.sessionId.trim()))) {
        throw new AgentProtocolError("invalid_argument", "Invalid resource request");
      }
      const resource = input as unknown as ResourceTicketResource;
      const target = await resolveResource(resource);
      try {
        const canonical = { filePath: resource.source === "bash-output" ? target.filePath : realpathSync(target.filePath),
          kind: resource.kind, sessionId: resource.sessionId, source: resource.source };
        if (!resource.source) {
          // 真实路径也必须可独立授权，避免链接别名扩大票据的能力。
          await resolveResource(canonical);
        }
        sendJson(res, 200, resourceTickets.issue(canonical), requestId);
      } finally { await target.handle?.close(); }
      return;
    }

    if (ticketContent) {
      if ([...url.searchParams.keys()].some((key) => key !== "ticket") || url.searchParams.getAll("ticket").length !== 1) {
        throw new AgentProtocolError("invalid_argument", "Only one ticket parameter is allowed");
      }
      const resource = resourceTickets.verify(url.searchParams.get("ticket") ?? "");
      const target = await resolveResource(resource);
      // 普通票据绑定签发时的真实路径；会话引用也不能用后来替换的链接扩大范围。
      if (!resource.source && realpathSync(target.filePath) !== resource.filePath) {
        throw new AgentProtocolError("forbidden", "Resource path has changed");
      }
      if (resource.kind === "preview") {
        const html = await renderDocumentPreview(target.filePath, target.stat);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(Buffer.byteLength(html)),
          "content-security-policy": `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'${frameOrigins.length ? " " + frameOrigins.join(" ") : ""}`,
          "x-request-id": requestId,
        });
        res.end(method === "HEAD" ? undefined : html);
      } else {
        await sendFileStream(req, res, target.filePath, target.stat,
          resource.source === "bash-output" ? "text/plain; charset=utf-8"
            : resource.kind === "read" ? readBinaryMime(target.filePath, target.stat)! : downloadMime(target.filePath),
          resource.kind === "download", true, target.handle);
      }
      return;
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
        try {
          const bytes = await readTextBody(toWebRequest(req));
          sendJson(res, 200, { size: writeTextFile(target.filePath, target.allowedRoots, bytes) }, requestId);
        } catch (error) {
          if (!(error instanceof FileWriteError)) throw error;
          sendError(res, error.status, error.status === 413 ? "payload_too_large" : "invalid_argument", error.message, requestId);
        }
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
            await sendFileStream(req, res, filePath, stat, binaryMime, false);
            return;
          }
          sendJson(res, 200, readTextFile(filePath, stat, allowedRoots), requestId);
          return;
        }
        if (type === "download") {
          await sendFileStream(req, res, filePath, stat, downloadMime(filePath), true);
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

    if (method === "POST" && url.pathname === "/v1/projects/select") {
      const { cwd } = await readObjectBody(req);
      sendJson(res, 200, selectProject(cwd), requestId);
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
        await handle.done.finally(finish);
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

    if (method === "POST" && url.pathname === "/v1/sessions") {
      sendJson(res, 200, await createSession(JSON.parse(await readBody(req)), runtime), requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/sessions") {
      sendJson(res, 200, await listSessionCatalog(runtime), requestId);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/sessions/titles") {
      const body = await readObjectBody(req);
      sendJson(res, 200, { titles: await listSessionTitles(body.ids) }, requestId);
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
        try {
          // spill 可能继续增长，不用打开时的大小作为响应长度。
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="bash-output.log"',
            "Cache-Control": "no-store",
            "x-request-id": requestId,
          });
          await pipeline(handle.createReadStream(), res);
        } finally {
          await handle.close();
        }
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
      const session = await resumeSession(sessionId, runtime);

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
          tree: url.searchParams.get("tree") === "preview" ? "preview" : undefined,
          deferThinking: url.searchParams.has("deferThinking"),
          deferToolResultImages: url.searchParams.has("deferMedia"),
        }), requestId);
        return;
      }
      if (method === "PATCH") {
        const body = await readObjectBody(req);
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
      try {
        const command = parseAgentCommand(JSON.parse(await readBody(req)));
        const session = await resumeSession(sessionId, runtime);
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

  async function resolveResource(resource: ResourceTicketResource): Promise<{ filePath: string; stat: Stats; handle?: FileHandle }> {
    if (resource.source === "bash-output") {
      const resolved = resolveBashOutputPath(resource.filePath, tmpdir());
      if (!resolved) throw new AgentProtocolError("invalid_argument", "Invalid bash output path");
      if (!resource.sessionId || !await isBashOutputPathReferencedBySession(resolved, resource.sessionId)) {
        throw new AgentProtocolError("forbidden", "Access denied");
      }
      try {
        const { handle, fileInfo } = await openRegularFileNoFollow(resolved);
        return { filePath: resolved, stat: fileInfo, handle };
      } catch {
        throw new AgentProtocolError("forbidden", "Bash output is unavailable or not a regular file");
      }
    }
    const target = await resolveFileTarget(normalizeFilePathSlashes(resource.filePath).split("/"), resource.kind, resource.sessionId);
    if (!target.stat.isFile()) throw new AgentProtocolError("invalid_argument", "Not a file");
    if (resource.kind === "read" && !readBinaryMime(target.filePath, target.stat)) {
      throw new AgentProtocolError("invalid_argument", "Resource read requires a binary file");
    }
    if (resource.kind === "preview") validateDocumentPreview(target.filePath, target.stat);
    return target;
  }

  // 浏览器会拒绝部分端口；自动选端口时必须避开，否则 UI 永远连不上。
  const listen = (port: number) => new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, config.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await listen(config.port);
  for (let attempt = 0; config.port === 0 && isBrowserBlockedPort((server.address() as AddressInfo).port) && attempt < 5; attempt++) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await listen(0);
  }
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

import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

// Desktop 静态 UI 的受限协议：weclio://app/... 从静态构建目录读取资产。
// 只服务 UI 文件，不代理任何 Agent API；API 仍走 HTTP + SSE。
export const APP_SCHEME = "weclio";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

function appCsp(serviceUrl) {
  let serviceOrigin = "";
  if (serviceUrl !== undefined) {
    // 配置只接受 HTTP(S) 裸 origin；拒绝 URL 标准化会掩盖的控制字符及 CSP 注入。
    if (typeof serviceUrl !== "string" || !/^https?:\/\//.test(serviceUrl) || /[\s;?'"#\\@*]/.test(serviceUrl)) {
      throw new Error("Service URL must be an HTTP(S) origin.");
    }
    const url = new URL(serviceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Service URL must be an HTTP(S) origin.");
    }
    serviceOrigin = ` ${url.origin}`;
  }
  // 远程 Markdown 图片保留 Web 行为；API、媒体和预览只授权已选 Service。
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    `media-src 'self' blob:${serviceOrigin}`,
    `connect-src 'self'${serviceOrigin}`,
    "worker-src 'self' blob:",
    `frame-src 'self' blob:${serviceOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const MIME_TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}));

export function contentTypeFor(filePath) {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/** 注册为特权 scheme：standard 才有稳定 origin，secure 才能用 fetch/localStorage。 */
export function registerAppScheme(protocolModule) {
  protocolModule.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

/**
 * 把 weclio://app/<path> 解析为构建目录内的绝对路径。
 * 任何越界（`..`、绝对路径、编码绕过）都返回 null，由调用方回 404。
 */
export function resolveAppAsset(rootDir, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST ||
      url.username || url.password || url.port) return null;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // 静态入口是单页应用：根路径给 index.html。
  if (pathname === "" || pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) return null;
  // 解码后显式拒绝 parent 段：normalize 会默默把 /.. 折成 /，从而掩盖越界意图。
  if (pathname.split(/[\\/]/).includes("..")) return null;

  const root = resolve(rootDir);
  const candidate = resolve(join(root, normalize(pathname)));
  // join+normalize 后再比较，挡住盘符绝对路径与同前缀目录（app-evil）。
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

export function assetHeaders(filePath, { serviceUrl } = {}) {
  return {
    "content-type": contentTypeFor(filePath),
    "content-security-policy": appCsp(serviceUrl),
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  };
}

/**
 * 生成 protocol.handle 的处理函数。
 * 只读静态文件：不存在或越界一律 404，不回退到任何服务器。
 */
export function createAppProtocolHandler(rootDir, { serviceUrl } = {}) {
  const headers = assetHeaders("index.html", { serviceUrl });
  return async (request) => {
    const filePath = resolveAppAsset(rootDir, request.url);
    if (!filePath) return new Response("Not found", { status: 404 });
    try {
      // 词法路径检查不覆盖 symlink/junction，读取前还要验证真实路径边界。
      const root = await realpath(rootDir);
      const target = await realpath(filePath);
      if (!target.startsWith(root + sep)) return new Response("Not found", { status: 404 });
      const info = await stat(target);
      if (!info.isFile()) return new Response("Not found", { status: 404 });
      const body = await readFile(target);
      return new Response(body, { status: 200, headers: { ...headers, "content-type": contentTypeFor(filePath) } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

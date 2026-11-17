import fs from "node:fs";
import path from "node:path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "../file-access";
import { resolveDirentIsDirectory } from "../file-dirent";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "../file-types";
import { FileWriteError, isEditableFile, writeExistingText } from "../file-write";
import { isFilePathReferencedBySession } from "../session-file-references";
import { AgentProtocolError } from "./protocol/validate";

// 文件能力：授权、读取、元数据、预览与写入都不依赖宿主；流式与 multipart 由适配层处理。

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];

export const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview", "watch"] as const;
export type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);

export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// multipart 边界与头部也要有上限。
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

export function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

export function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

export interface FileTarget {
  filePath: string;
  allowedRoots: Set<string>;
  stat: fs.Stats;
  allowedBySessionReference: boolean;
}

/** 授权 + 存在性检查：根内路径优先，其次允许会话引用（列表除外）。 */
export async function resolveFileTarget(
  segments: string[],
  type: FileRequestType,
  sessionId?: string | null,

): Promise<FileTarget> {
  const filePath = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots();
  const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
  const allowedBySessionReference = !allowedByRoot
    && type !== "list"
    && await isFilePathReferencedBySession(filePath, sessionId ?? null);
  if (!allowedByRoot && !allowedBySessionReference) {
    throw new AgentProtocolError("forbidden", "Access denied");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new AgentProtocolError("not_found", "Not found");
  }
  if (!allowedBySessionReference && !isExistingFilePathAllowed(filePath, allowedRoots)) {
    throw new AgentProtocolError("forbidden", "Access denied");
  }
  return { filePath, allowedRoots, stat, allowedBySessionReference };
}

/** 上传目标目录：词法根与 realpath 双重校验，防止根内符号链接把写入引到根外。 */
export async function resolveUploadDirectory(segments: string[]): Promise<string> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directory, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new AgentProtocolError("not_found", "Upload directory not found");
  }
  if (!stat.isDirectory()) throw new AgentProtocolError("invalid_argument", "Upload target is not a directory");

  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // 忽略已失效的会话根。
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  return realDirectory;
}

export interface DirectoryEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

/** 目录列表：普通文件/目录不逐项 stat，符号链接与未知类型才回退。 */
export function listDirectory(filePath: string): DirectoryEntry[] {
  return fs.readdirSync(filePath, { withFileTypes: true })
    .filter((entry) => !IGNORED_NAMES.has(entry.name) && !IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
    .flatMap((entry) => {
      const isDir = resolveDirentIsDirectory(entry, path.join(filePath, entry.name));
      return isDir === null ? [] : [{ name: entry.name, isDir, size: 0, modified: "" }];
    })
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
}

function requireFile(stat: fs.Stats): void {
  if (!stat.isFile()) throw new AgentProtocolError("invalid_argument", "Not a file");
}

export interface TextFileView {
  content: string;
  language: string;
  size: number;
  editable: boolean;
}

export function readTextFile(filePath: string, stat: fs.Stats, allowedRoots: Set<string>): TextFileView {
  requireFile(stat);
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
    throw new AgentProtocolError("payload_too_large", "File too large for preview (>256KB)");
  }
  return {
    content: fs.readFileSync(filePath, "utf-8"),
    language: getLanguage(filePath),
    size: stat.size,
    editable: isEditableFile(filePath, allowedRoots),
  };
}

export interface FileMetaView {
  size: number;
  language: string;
  mime: string;
  previewKind: ReturnType<typeof documentPreviewKind>;
  editable: boolean;
}

export function readFileMeta(filePath: string, stat: fs.Stats, allowedRoots: Set<string>): FileMetaView {
  requireFile(stat);
  return {
    size: stat.size,
    language: getLanguage(filePath),
    mime: getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "text/plain",
    previewKind: documentPreviewKind(filePath),
    editable: isEditableFile(filePath, allowedRoots),
  };
}

/** 二进制读取（图片/音频/文档）：需要按流返回时使用对应 mime。 */
export function readBinaryMime(filePath: string, stat: fs.Stats): string | null {
  requireFile(stat);
  const imageMime = getImageMime(filePath);
  if (imageMime) {
    if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
      throw new AgentProtocolError("payload_too_large", "Image too large (>10MB)");
    }
    return imageMime;
  }
  return getAudioMime(filePath) || getDocumentMime(filePath) || null;
}

export function downloadMime(filePath: string): string {
  return getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

/** 签发和兑换票据都先检查预览类型与大小，不触发转换。 */
export function validateDocumentPreview(filePath: string, stat: fs.Stats): void {
  requireFile(stat);
  if (getFileExt(filePath) !== "docx") {
    throw new AgentProtocolError("invalid_argument", "Preview not available for this file type");
  }
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    throw new AgentProtocolError("payload_too_large", "DOCX too large for preview (>10MB)");
  }
}

/** DOCX 预览：只转换本地文件内容，禁止外部引用。 */
export async function renderDocumentPreview(filePath: string, stat: fs.Stats): Promise<string> {
  validateDocumentPreview(filePath, stat);
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { path: filePath },
    { externalFileAccess: false, convertImage: mammoth.images.dataUri },
  );
  return wrapDocxPreviewHtml(result.value, path.basename(filePath));
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDispositionFor(filePath: string, asDownload = false): string {
  const disposition = asDownload ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

/** 文件响应头；SVG 可被浏览器当文档执行，额外加限制。 */
export function fileResponseHeaders(filePath: string, contentType: string, asDownload = false): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDispositionFor(filePath, asDownload),
    "X-Content-Type-Options": "nosniff",
  };
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    headers["Referrer-Policy"] = "no-referrer";
  }
  return headers;
}

export interface ByteRange {
  start: number;
  end: number;
}

/** 解析单段 Range；invalid 表示应返回 416。 */
export function parseByteRange(rangeHeader: string, size: number): ByteRange | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return "invalid";
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

/** 写入已存在文本文件前的授权与冲突检查都在 writeExistingText 内完成。 */
export function writeTextFile(target: string, allowedRoots: Set<string>, bytes: Uint8Array): number {
  if (!isFilePathAllowed(target, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  try {
    return writeExistingText(target, allowedRoots, bytes);
  } catch (error) {
    if (error instanceof FileWriteError) {
      throw new AgentProtocolError(error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : "invalid_argument", error.message);
    }
    throw error;
  }
}

export function isWindowsAbsoluteFilePath(filePath: string): boolean {
  return isWindowsAbsolutePath(filePath);
}

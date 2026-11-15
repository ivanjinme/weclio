import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "../file-fuzzy";
import { requireAllowedDirectory } from "./workspace-service";

const execFileAsync = promisify(execFile);

// 与 /api/files 相同的跳过列表；git 仓库依赖 .gitignore（对应 TUI 的 fd 行为）。
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];

const MAX_FILES = 5000;
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  files: string[];
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  entries?: FileIndexEntry[];
  expiresAt: number;
}

declare global {
  var __weclioFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  return globalThis.__weclioFileIndexCache ??= new Map();
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    return all.length > GIT_HARD_CAP
      ? { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true }
      : { files: all, hardTruncated: false };
  } catch {
    // 不是 git 仓库或 git 不可用 → 回退到 readdir 遍历。
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  // BFS：截断时较浅的文件优先保留。
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (IGNORED_NAMES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) queue.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (files.length >= WALK_HARD_CAP) return { files, hardTruncated: true };
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

export type FileIndexView =
  | { files: string[]; truncated: boolean }
  | { matches: ReturnType<typeof filterFileEntries> };

/** 文件索引：无查询返回客户端索引，有查询则在完整列表中排序匹配。 */
export async function fileIndex(cwdValue: unknown, queryValue?: string | null): Promise<FileIndexView> {
  const cwd = await requireAllowedDirectory(cwdValue);
  const query = (queryValue ?? "").slice(0, MAX_QUERY_LENGTH);

  const cache = getIndexCache();
  const now = Date.now();
  let cached = cache.get(cwd);
  if (!cached || cached.expiresAt <= now) {
    const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cached = { listing, expiresAt: now + CACHE_TTL_MS };
    cache.set(cwd, cached);
  }

  if (query) {
    cached.entries ??= buildEntriesFromFiles(cached.listing.files);
    return { matches: filterFileEntries(cached.entries, query) };
  }

  const { files, hardTruncated } = cached.listing;
  return { files: files.slice(0, MAX_FILES), truncated: hardTruncated || files.length > MAX_FILES };
}

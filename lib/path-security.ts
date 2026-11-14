import { realpathSync } from "fs";
import path from "path";

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) return true;
  }
  return false;
}

/** Detect literal parent traversal segments before path normalization or realpath. */
export function hasParentDirectorySegment(target: string): boolean {
  // On Windows both slash styles delimit path segments; on POSIX a
  // backslash is a valid filename character and must not be normalized.
  const windowsPath = process.platform === "win32" || isWindowsAbsolutePath(target);
  const segments = windowsPath ? target.replaceAll("\\\\", "/").split("/") : target.split("/");
  return segments.includes("..");
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync(root));
    } catch {
      // 忽略已不存在的会话目录。
    }
  }
  return isPathWithinRoots(realTarget, realRoots);
}

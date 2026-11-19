import { lstatSync } from "node:fs";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "../file-access";
import { getGitFileDiff, getGitStatus } from "../git-changes";
import { hasParentDirectorySegment } from "../path-security";
import { AgentProtocolError } from "./protocol/validate";
import { requireAllowedDirectory } from "./workspace-service";

// Git 查询：授权与子进程都留在 Service 侧，宿主只做 HTTP 适配。

function isDiffPathAllowed(filePath: string, allowedRoots: Set<string>): boolean {
  if (hasParentDirectorySegment(filePath)) return false;
  // 文件可能已删除；授权其最近的已存在祖先。悬挂链接或指向根外的链接一律拒绝。
  let candidate = filePath;
  while (isFilePathAllowed(candidate, allowedRoots)) {
    try {
      lstatSync(candidate);
      return isExistingFilePathAllowed(candidate, allowedRoots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
  return false;
}

export type GitStatusView = Awaited<ReturnType<typeof getGitStatus>>;
export type GitDiffView = Awaited<ReturnType<typeof getGitFileDiff>>;

export async function gitStatus(cwdValue: unknown): Promise<GitStatusView> {
  return getGitStatus(await requireAllowedDirectory(cwdValue));
}

export async function gitDiff(cwdValue: unknown, pathValue: unknown): Promise<GitDiffView> {
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    throw new AgentProtocolError("invalid_argument", "path must be an absolute path");
  }
  const filePath = pathValue;
  if (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath)) {
    throw new AgentProtocolError("invalid_argument", "path must be an absolute path");
  }
  const cwd = await requireAllowedDirectory(cwdValue);

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(filePath, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  // 校验物理目标：已删除文件只要最近的祖先仍在根内即可。
  if (hasParentDirectorySegment(cwd) || !isDiffPathAllowed(filePath, allowedRoots)) {
    throw new AgentProtocolError("forbidden", "Access denied");
  }
  return getGitFileDiff(cwd, filePath);
}

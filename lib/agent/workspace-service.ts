import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentProtocolError } from "./protocol/validate";
import type { AgentRuntime } from "../rpc-manager";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  resolveDirectory,
} from "../directory-browser";
import { replaceAllowedFileRoot } from "../allowed-roots";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "../file-access";
import { invalidateModelsCache } from "../models-cache";
import { getProjectTrustStatus, trustProject } from "../project-trust";
import { readSidebarPins, rebindPinnedProject, setSidebarPin, type SidebarPin } from "../sidebar-pins";
import { sessionPathKey } from "../session-path";
import { invalidateSessionListCache, listAllSessions } from "../session-reader";

// 工作区、项目信任与置顶：与宿主无关，Next 路由与独立 Service 共用同一实现。

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

function requireDirectorySync(cwd: string): void {
  let status: ReturnType<typeof statSync> | undefined;
  try {
    status = statSync(cwd);
  } catch {
    throw new AgentProtocolError("invalid_argument", `Directory does not exist: ${cwd}`);
  }
  if (!status.isDirectory()) throw new AgentProtocolError("invalid_argument", `Path is not a directory: ${cwd}`);
}

export function getHomeDirectory(): string {
  return homedir();
}

/** 创建（或复用）确定性的默认工作区，并授权文件访问。 */
export function ensureWorkspace(path: string): string {
  const cwd = resolve(path);
  mkdirSync(cwd, { recursive: true });
  allowFileRoot(cwd);
  return cwd;
}

export interface ValidatedWorkspace {
  cwd: string;
}

export function validateWorkspace(value: unknown): ValidatedWorkspace {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new AgentProtocolError("invalid_argument", "Path is required");
  const cwd = normalizeCwd(raw);
  requireDirectorySync(cwd);
  allowFileRoot(cwd);
  return { cwd };
}

/** 授权的绝对目录：词法根 + 物理 realpath 双重校验，供 git/index/files 复用。 */
export async function requireAllowedDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentProtocolError("invalid_argument", "cwd must be an absolute path");
  }
  const cwd = value.trim();
  if (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd)) {
    throw new AgentProtocolError("invalid_argument", "cwd must be an absolute path");
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  let status: ReturnType<typeof statSync>;
  try {
    status = statSync(cwd);
  } catch {
    throw new AgentProtocolError("not_found", "Directory not found");
  }
  if (!status.isDirectory()) throw new AgentProtocolError("invalid_argument", "Not a directory");
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  return cwd;
}

export interface BrowseResult {
  path: string;
  parentPath: string | null;
  directories: Awaited<ReturnType<typeof listDirectories>>;
}

export async function browseWorkspace(requested?: string | null): Promise<BrowseResult> {
  const candidate = getBrowseStartDirectory(requested?.trim() || undefined);
  let resolved: string;
  try {
    resolved = await resolveDirectory(candidate);
  } catch {
    throw new AgentProtocolError("not_found", "Directory does not exist");
  }
  const directoryStat = await stat(resolved);
  if (!directoryStat.isDirectory()) throw new AgentProtocolError("invalid_argument", "Path is not a directory");
  return {
    path: resolved,
    parentPath: getParentDirectory(resolved),
    directories: await listDirectories(resolved),
  };
}

/** cwd 必须已被允许的根覆盖，避免用 trust 接口探测任意路径。 */
async function requireAllowedProject(value: unknown): Promise<{ cwd: string }> {
  if (typeof value !== "string" || !value.trim()) throw new AgentProtocolError("invalid_argument", "cwd required");
  let cwd: string;
  try {
    cwd = await resolveDirectory(value);
  } catch {
    throw new AgentProtocolError("invalid_argument", "Directory does not exist");
  }
  if (!(await stat(cwd)).isDirectory()) throw new AgentProtocolError("invalid_argument", "cwd must be a directory");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  return { cwd };
}

export interface ProjectTrustView {
  requiresTrust: boolean;
  trusted: boolean;
}

export async function readProjectTrust(value: unknown): Promise<ProjectTrustView> {
  const { cwd } = await requireAllowedProject(value);
  return getProjectTrustStatus(cwd, getAgentDir());
}

/** 信任项目必须空闲：先判定，再写信任库并让模型缓存与受限运行实例失效。 */
export async function grantProjectTrust(value: unknown, runtime: AgentRuntime): Promise<ProjectTrustView> {
  const { cwd } = await requireAllowedProject(value);
  const agentDir = getAgentDir();
  const current = getProjectTrustStatus(cwd, agentDir);
  if (!current.requiresTrust) {
    throw new AgentProtocolError("conflict", "This project has no resources that require trust");
  }
  if (runtime.hasBusyForCwd(cwd)) {
    throw new AgentProtocolError("conflict", "Wait for the active session to finish before trusting this project");
  }
  const status = trustProject(cwd, agentDir);
  invalidateModelsCache();
  await runtime.destroyForCwds([cwd]);
  return status;
}

interface RebindRequest {
  oldRoot?: unknown;
  newRoot?: unknown;
}

function replaceSessionCwd(source: string, newRoot: string): string {
  const newlineIndex = source.indexOf("\n");
  const firstLineEnd = newlineIndex === -1 ? source.length : newlineIndex;
  const firstLine = source.slice(0, firstLineEnd).replace(/\r$/, "");
  const header = JSON.parse(firstLine) as { type?: string; cwd?: string };
  if (header.type !== "session") throw new Error("Invalid session header");
  header.cwd = newRoot;
  const lineEnding = source.slice(firstLine.length, firstLineEnd + 1);
  return JSON.stringify(header) + lineEnding + source.slice(firstLineEnd + 1);
}

export interface RebindResult {
  ok: true;
  migratedSessions: number;
  cwd: string;
}

/** 项目重绑：先拒绝运行中的项目，再准备全部改写，失败时回滚已写文件。 */
export async function rebindProject(body: RebindRequest, runtime: AgentRuntime): Promise<RebindResult> {
  const oldRoot = typeof body.oldRoot === "string" ? body.oldRoot.trim() : "";
  const newRoot = typeof body.newRoot === "string" ? body.newRoot.trim() : "";
  if (!oldRoot || !newRoot) throw new AgentProtocolError("invalid_argument", "oldRoot and newRoot are required");

  let newStat: ReturnType<typeof statSync>;
  try {
    newStat = statSync(newRoot);
  } catch {
    throw new AgentProtocolError("invalid_argument", `Directory does not exist: ${newRoot}`);
  }
  if (!newStat.isDirectory()) throw new AgentProtocolError("invalid_argument", `Path is not a directory: ${newRoot}`);

  const oldKey = sessionPathKey(oldRoot);
  const newKey = sessionPathKey(newRoot);
  if (oldKey === newKey) {
    allowFileRoot(newRoot);
    return { ok: true, migratedSessions: 0, cwd: newRoot };
  }

  const sessions = await listAllSessions();
  const matching = sessions.filter((session) => session.cwd && sessionPathKey(session.cwd) === oldKey);
  const involvedCwds = new Map<string, string>([[oldKey, oldRoot]]);
  for (const session of matching) involvedCwds.set(sessionPathKey(session.cwd), session.cwd);

  if (runtime.hasBusyForCwds(involvedCwds.values())) {
    throw new AgentProtocolError("conflict", "A task is still running in this project. Stop it before changing the source folder.");
  }
  await runtime.destroyForCwds(involvedCwds.values());

  const prepared = matching.map((session) => {
    const source = readFileSync(session.path, "utf8");
    return { path: session.path, source, updated: replaceSessionCwd(source, newRoot) };
  });
  const written: typeof prepared = [];
  try {
    for (const item of prepared) {
      writeFileSync(item.path, item.updated, "utf8");
      written.push(item);
    }
    rebindPinnedProject(oldRoot, newRoot);
  } catch (error) {
    for (const item of written) {
      try { writeFileSync(item.path, item.source, "utf8"); } catch { /* 尽力回滚 */ }
    }
    throw error;
  }

  replaceAllowedFileRoot(oldRoot, newRoot);
  invalidateSessionListCache();
  return { ok: true, migratedSessions: prepared.length, cwd: newRoot };
}

export function listPins(): SidebarPin[] {
  return readSidebarPins();
}

export function setPinned(type: SidebarPin["type"], id: string, pinned: boolean): SidebarPin[] {
  if ((type !== "project" && type !== "session") || typeof id !== "string" || !id.trim() || typeof pinned !== "boolean") {
    throw new AgentProtocolError("invalid_argument", "type, id and pinned are required");
  }
  return setSidebarPin({ type, id }, pinned);
}

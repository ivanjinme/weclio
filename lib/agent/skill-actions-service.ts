import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInstallScope, SkillSearchResult } from "../api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { runNpx } from "../npx";
import { getProjectTrustStatus } from "../project-trust";
import { setDisableModelInvocation } from "../skill-frontmatter";
import { buildSkillUpdateArgs, checkSkillUpdates } from "../skill-updates";
import { loadSkillsWithInstallInfo } from "../skills-service";
import { AgentProtocolError } from "./protocol/validate";

// Skills 操作：列举、切换模型调用、检查/安装/更新、远端搜索。与宿主无关。

const ANSI_PATTERN = new RegExp(String.raw`\x1B\[[0-9;]*m`, "g");
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

/** 安装/更新是外部子进程，必须占用执行准入。 */
export type ReserveTask = () => () => void;
const noopReserve: ReserveTask = () => () => {};

export interface SkillListQuery {
  cwd?: string | null;
  globalOnly?: boolean;
}

async function requireAllowedCwd(cwd: string): Promise<void> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
}

export async function listSkills(query: SkillListQuery) {
  const cwd = query.cwd?.trim() || undefined;
  const globalOnly = query.globalOnly === true;
  if (!cwd && !globalOnly) throw new AgentProtocolError("invalid_argument", "cwd required");
  if (cwd) await requireAllowedCwd(cwd);
  return loadSkillsWithInstallInfo(globalOnly ? undefined : cwd);
}

/**
 * 切换某个 SKILL.md 的 disable-model-invocation。
 * 全局安装的 skill 位于 ~/.agents/skills，符号链接会解析到 agentDir 之外，需额外授权。
 */
export async function setSkillModelInvocation(body: unknown): Promise<void> {
  const { filePath, disableModelInvocation } = (body ?? {}) as {
    filePath?: unknown;
    disableModelInvocation?: unknown;
  };
  if (typeof filePath !== "string" || !filePath) throw new AgentProtocolError("invalid_argument", "filePath required");
  if (!existsSync(filePath)) throw new AgentProtocolError("not_found", "file not found");

  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(getAgentDir());
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  if (!isExistingFilePathAllowed(filePath, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");

  const content = readFileSync(filePath, "utf8");
  writeFileSync(filePath, setDisableModelInvocation(content, disableModelInvocation === true), "utf8");
}

interface SkillTargetInput {
  cwd?: unknown;
  package?: unknown;
  scope?: unknown;
}

function readSkillTarget(body: SkillTargetInput) {
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const pkg = typeof body.package === "string" ? body.package.trim() : "";
  const scope = body.scope === "global" || body.scope === "project"
    ? body.scope as SkillInstallScope
    : undefined;
  return { cwd, pkg, scope };
}

/** 检查已安装 skill 是否有更新；不传 package 则检查全部。 */
export async function checkUpdates(body: SkillTargetInput) {
  const { cwd, pkg, scope } = readSkillTarget(body);
  if (cwd) await requireAllowedCwd(cwd);
  if ((pkg && !scope) || (!pkg && scope)) {
    throw new AgentProtocolError("invalid_argument", "package and scope must be provided together");
  }

  const { skills } = await loadSkillsWithInstallInfo(cwd || undefined);
  const installs = skills
    .map((skill) => skill.install)
    .filter((install): install is NonNullable<typeof install> => Boolean(install))
    .filter((install) => !pkg || (install.package === pkg && install.scope === scope));
  if (pkg && installs.length === 0) throw new AgentProtocolError("not_found", "Installed skill not found");

  const updates = await checkSkillUpdates(installs, {
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });
  return { updates };
}

function subprocessDetail(error: unknown): string {
  const detail = error as { stdout?: string; stderr?: string; message?: string };
  const output = `${detail.stdout ?? ""}${detail.stderr ?? ""}`.replace(ANSI_PATTERN, "");
  return output || detail.message || String(error);
}

/** 通过 npx skills add 安装；项目级安装要求已授权且已信任。 */
export async function installSkill(
  body: { package?: unknown; scope?: unknown; cwd?: unknown },
  reserveTask: ReserveTask = noopReserve,
) {
  const pkg = typeof body.package === "string" ? body.package.trim() : "";
  if (!pkg) throw new AgentProtocolError("invalid_argument", "package required");
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const isGlobal = body.scope !== "project";

  if (!isGlobal) {
    if (!cwd) throw new AgentProtocolError("invalid_argument", "cwd required for project install");
    await requireAllowedCwd(cwd);
    if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
      throw new AgentProtocolError("forbidden", "Project resources must be trusted before installing project skills");
    }
  }

  const args = ["skills", "add", pkg, "-y", "--agent", "pi"];
  if (isGlobal) args.push("-g");
  const release = reserveTask();
  try {
    const { stdout, stderr } = await runNpx(args, { timeout: 60000, cwd: !isGlobal && cwd ? cwd : undefined });
    const output = `${stdout}${stderr}`.replace(ANSI_PATTERN, "");
    if (!/Installation complete|Installed \d+ skill/.test(output)) {
      throw new AgentProtocolError("command_failed", output.slice(-300) || "Install failed");
    }
    return { success: true as const, output };
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw new AgentProtocolError("command_failed", subprocessDetail(error));
  } finally {
    release();
  }
}

/** 更新单个已安装 skill，并回传刷新后的安装信息。 */
export async function updateSkill(
  body: SkillTargetInput,
  reserveTask: ReserveTask = noopReserve,
) {
  const { cwd, pkg, scope } = readSkillTarget(body);
  if (!pkg || !scope || (!cwd && scope === "project")) {
    throw new AgentProtocolError("invalid_argument", "cwd, package, and scope are required");
  }
  if (cwd) await requireAllowedCwd(cwd);

  const { skills } = await loadSkillsWithInstallInfo(cwd || undefined);
  const skill = skills.find((item) => item.install?.package === pkg && item.install.scope === scope);
  if (!skill?.install) throw new AgentProtocolError("not_found", "Installed skill not found");
  if (!skill.install.canCheckForUpdates) {
    throw new AgentProtocolError("invalid_argument", "This skill cannot be updated automatically");
  }

  const release = reserveTask();
  try {
    const { stdout, stderr } = await runNpx(buildSkillUpdateArgs(skill.install), {
      timeout: 60_000,
      cwd: scope === "project" ? cwd : undefined,
    });
    const refreshed = await loadSkillsWithInstallInfo(cwd || undefined);
    const updated = refreshed.skills.find((item) => item.install?.package === pkg && item.install.scope === scope);
    return { success: true as const, skill: updated, output: `${stdout}${stderr}`.slice(-500) };
  } catch (error) {
    throw new AgentProtocolError("command_failed", subprocessDetail(error));
  } finally {
    release();
  }
}

interface SkillsApiSkill {
  id?: string;
  name?: string;
  source?: string;
  installs?: number;
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(num)));
}

function formatInstalls(count?: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseInstallCount(installs: string): number {
  const match = /^([\d.]+)([KMB])?\s+installs?$/.exec(installs);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

/** 解析 `npx skills find` 的文本输出；CLI 输出格式变化时返回空列表。 */
export function parseSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_PATTERN, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const pkgMatch = /^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/.exec(line);
    if (!pkgMatch) continue;
    const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
    results.push({
      package: pkgMatch[1],
      installs: pkgMatch[2],
      url: urlLine?.startsWith("https://") ? urlLine : "",
    });
  }
  return results;
}

async function searchSkillsApi(query: string, limit: number): Promise<SkillSearchResult[]> {
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { skills?: SkillsApiSkill[] };
  return (data.skills ?? [])
    .map((skill) => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;
      return {
        package: `${source || slug}@${name}`,
        installs: formatInstalls(skill.installs),
        url: slug ? `${SEARCH_API_BASE}/${slug}` : "",
      };
    })
    .filter((item): item is SkillSearchResult => item !== null)
    .sort((a, b) => parseInstallCount(b.installs) - parseInstallCount(a.installs));
}

/** 搜索远端 skill：优先 REST API，失败时回退 CLI。 */
export async function searchSkills(body: { query?: unknown; limit?: unknown }) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw new AgentProtocolError("invalid_argument", "query required");
  const limit = parseLimit(body.limit);

  try {
    return { results: await searchSkillsApi(query, limit) };
  } catch {
    try {
      const { stdout, stderr } = await runNpx(["skills", "find", query], { timeout: 20000 });
      return { results: parseSearchOutput(`${stdout}${stderr}`).slice(0, limit) };
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      const raw = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
      const results = raw ? parseSearchOutput(raw) : [];
      if (results.length > 0) return { results };
      throw new AgentProtocolError("command_failed", detail.message ?? String(error));
    }
  }
}

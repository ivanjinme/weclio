import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { getExtensionPackageName } from "../extension-package-name";
import { getProjectTrustStatus } from "../project-trust";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginsResponse,
} from "../api-types";
import { AgentProtocolError } from "./protocol/validate";

// 插件/资源包：列举与安装/删除/更新/启停。与宿主无关，Next 与 Service 共用。

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

function getDisabledPackages(settingsManager: SettingsManager): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "global"), isDisabledPackage(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "project"), isDisabledPackage(entry));
  }
  return disabled;
}

function setPackageDisabled(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginScope,
  disabled: boolean,
): boolean {
  const current = scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
  let changed = false;
  const next = current.map((entry): PackageSource => {
    if (getPackageSource(entry) !== source) return entry;
    changed = true;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    return getPackageSource(entry);
  });
  if (!changed) return false;
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

function getRelativePath(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return resource.path;
  const rel = relative(baseDir, resource.path);
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

function getConfiguredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }

  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return {};
  }
}

function collectResource(
  resource: ResolvedResource,
  kind: keyof PluginResourceCounts,
  countsByPackage: Map<string, PluginResourceCounts>,
  resourcesByPackage: Map<string, PluginResourceInfo[]>,
  totals: PluginResourceCounts,
): void {
  if (!resource.enabled || resource.metadata.origin !== "package") return;
  const source = resource.metadata.source;
  const scope = toPluginScope(resource.metadata.scope);
  const key = keyFor(source, scope);
  const counts = countsByPackage.get(key) ?? emptyCounts();
  addCount(counts, kind);
  addCount(totals, kind);
  countsByPackage.set(key, counts);
  const resources = resourcesByPackage.get(key) ?? [];
  const resourceKind = kind === "extensions"
    ? "extension"
    : kind === "skills"
      ? "skill"
      : kind === "prompts"
        ? "prompt"
        : "theme";
  resources.push({
    kind: resourceKind,
    name: (resourceKind === "extension"
      ? getExtensionPackageName(resource.path, resource.metadata.packageRoot)
      : undefined) ?? getResourceName(resource.path, resourceKind),
    path: resource.path,
    relativePath: getRelativePath(resource),
  });
  resourcesByPackage.set(key, resources);
}

function collectResources(paths: ResolvedPaths): {
  countsByPackage: Map<string, PluginResourceCounts>;
  resourcesByPackage: Map<string, PluginResourceInfo[]>;
  totals: PluginResourceCounts;
} {
  const countsByPackage = new Map<string, PluginResourceCounts>();
  const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  const totals = emptyCounts();
  for (const resource of paths.extensions) collectResource(resource, "extensions", countsByPackage, resourcesByPackage, totals);
  for (const resource of paths.skills) collectResource(resource, "skills", countsByPackage, resourcesByPackage, totals);
  for (const resource of paths.prompts) collectResource(resource, "prompts", countsByPackage, resourcesByPackage, totals);
  for (const resource of paths.themes) collectResource(resource, "themes", countsByPackage, resourcesByPackage, totals);
  return { countsByPackage, resourcesByPackage, totals };
}

async function readPlugins(cwd: string, globalOnly = false): Promise<PluginsResponse> {
  const agentDir = getAgentDir();
  const projectTrust = globalOnly ? { trusted: false } : getProjectTrustStatus(cwd, agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });

  const diagnostics: PluginDiagnostic[] = [];
  let countsByPackage = new Map<string, PluginResourceCounts>();
  let resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  let totals = emptyCounts();
  const disabledByPackage = getDisabledPackages(settingsManager);

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({
        type: "warning",
        source,
        message: "Package is configured but not installed yet.",
      });
      return "skip";
    });
    ({ countsByPackage, resourcesByPackage, totals } = collectResources(resolved));
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const packages = packageManager.listConfiguredPackages().map((pkg) => {
    const scope = toPluginScope(pkg.scope);
    const key = keyFor(pkg.source, scope);
    const disabled = disabledByPackage.get(key) ?? false;
    const counts = countsByPackage.get(key) ?? emptyCounts();
    const resources = resourcesByPackage.get(key) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(pkg.installedPath);
    if (!pkg.installedPath) {
      diagnostics.push({
        type: "warning",
        source: pkg.source,
        message: "Configured package path was not found.",
      });
    }
    return {
      source: pkg.source,
      scope,
      filtered: pkg.filtered,
      disabled,
      installedPath: pkg.installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      configuredVersion: getConfiguredVersion(pkg.source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });

  return {
    packages,
    totals,
    diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
  };
}

export interface PluginListQuery {
  cwd?: string | null;
  globalOnly?: boolean;
}

/** 列出已配置资源包；cwd 必须落在允许的根内。 */
export async function listPlugins(query: PluginListQuery): Promise<PluginsResponse> {
  const cwd = query.cwd?.trim() || undefined;
  const globalOnly = query.globalOnly === true;
  if (!cwd && !globalOnly) throw new AgentProtocolError("invalid_argument", "cwd required");
  if (cwd) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  }
  return readPlugins(cwd ?? homedir(), globalOnly);
}

export interface PluginMutationInput {
  action?: string;
  source?: string;
  scope?: string;
  cwd?: string;
}

/** 修改资源包；项目级改动要求项目已信任。 */
export async function mutatePlugins(body: PluginMutationInput): Promise<PluginsResponse> {
  if (!body.action) throw new AgentProtocolError("invalid_argument", "action required");
  const scope = body.scope === "project" ? "project" : "global";
  if (!body.cwd && scope === "project") throw new AgentProtocolError("invalid_argument", "cwd required");
  if (body.cwd) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) throw new AgentProtocolError("forbidden", "Access denied");
  }

  const cwd = body.cwd ?? homedir();
  const agentDir = getAgentDir();
  const projectTrust = body.cwd ? getProjectTrustStatus(body.cwd, agentDir) : { trusted: false };
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrust.trusted });
  if (scope === "project" && !projectTrust.trusted) {
    throw new AgentProtocolError("forbidden", "Project resources must be trusted before modifying project plugins");
  }
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const source = body.source?.trim();
  const local = scope === "project";

  if (body.action === "install") {
    if (!source) throw new AgentProtocolError("invalid_argument", "source required");
    await packageManager.installAndPersist(source, { local });
  } else if (body.action === "remove") {
    if (!source) throw new AgentProtocolError("invalid_argument", "source required");
    await packageManager.removeAndPersist(source, { local });
  } else if (body.action === "update") {
    await packageManager.update(source);
  } else if (body.action === "disable" || body.action === "enable") {
    if (!source) throw new AgentProtocolError("invalid_argument", "source required");
    setPackageDisabled(settingsManager, source, scope, body.action === "disable");
    await settingsManager.flush();
  } else {
    throw new AgentProtocolError("invalid_argument", `Unsupported action: ${body.action}`);
  }

  return readPlugins(cwd, !body.cwd);
}

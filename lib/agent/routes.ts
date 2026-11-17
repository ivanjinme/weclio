// 宿主路由表：同一 AgentClient 接口对两种宿主生成各自的 URL。
// Next 宿主保留历史形态；Service 使用版本化的 REST 形态（/v1）。
// 路由由「基址 + profile」决定，不读全局状态，因此每个 Client 可以指向不同环境。

export type HostProfile = "next" | "service";

/** 历史 UI 路径只在客户端转换，Service 不保留 Next 别名。 */
export function resolveApiPath(path: string, profile: HostProfile, method = "GET"): string {
  if (profile === "next") return path;
  const boundary = path.search(/[?#]/);
  const pathname = boundary < 0 ? path : path.slice(0, boundary);
  const suffix = boundary < 0 ? "" : path.slice(boundary);
  const aliases: Record<string, string> = {
    "/cwd/default": "/workspaces/default",
    "/cwd/validate": "/workspaces/validate",
    "/cwd/browse": "/workspaces/browse",
    "/sidebar-pins": "/settings/pins",
    "/project-trust": "/projects/trust",
    "/file-index": "/files/index",
    "/models-config": "/settings/models",
    "/auth/providers": "/provider-auth/oauth",
    "/auth/all-providers": "/provider-auth/providers",
    "/agent/new": "/sessions",
    "/agent/running/events": "/events",
  };
  let resolved = aliases[pathname] ?? pathname;
  if (pathname === "/sessions" && method.toUpperCase() === "POST") resolved = "/sessions/titles";
  else if (pathname.startsWith("/models-config/")) resolved = pathname.replace("/models-config/", "/settings/models/");
  else if (!aliases[pathname] && pathname.startsWith("/auth/")) resolved = pathname.replace("/auth/", "/provider-auth/");
  else if (/^\/agent\/[^/]+\/bash-output$/.test(pathname)) resolved = pathname.replace("/agent/", "/sessions/");
  else if (!aliases[pathname] && /^\/agent\/[^/]+$/.test(pathname)) resolved = pathname.replace("/agent/", "/sessions/") + "/state";
  return resolved + suffix;
}

export interface ApiBase {
  baseUrl: string;
  basePath: string;
}

export interface HostRoutes {
  readonly profile: HostProfile;
  commands: (sessionId: string) => string;
  events: (sessionId: string, cwd?: string | null) => string;
  runningEvents: () => string;
  state: (sessionId: string) => string;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function join(base: ApiBase, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base.baseUrl}${base.basePath}${suffix}`;
}

const nextRoutes = (base: ApiBase): HostRoutes => ({
  profile: "next",
  commands: (sessionId) => join(base, `/agent/${encode(sessionId)}`),
  events: (sessionId) => join(base, `/agent/${encode(sessionId)}/events`),
  runningEvents: () => join(base, "/agent/running/events"),
  state: (sessionId) => join(base, `/sessions/${encode(sessionId)}/state`),
});

const serviceRoutes = (base: ApiBase): HostRoutes => ({
  profile: "service",
  commands: (sessionId) => join(base, `/sessions/${encode(sessionId)}/commands`),
  events: (sessionId, cwd) => join(base, `/sessions/${encode(sessionId)}/events${cwd ? `?cwd=${encode(cwd)}` : ""}`),
  runningEvents: () => join(base, "/events"),
  state: (sessionId) => join(base, `/sessions/${encode(sessionId)}/state`),
});

/** 由 API 基址推断宿主：显式 /v1 前缀即独立 Service。 */
export function resolveHostProfile(basePath: string): HostProfile {
  return basePath.replace(/\/+$/, "") === "/v1" ? "service" : "next";
}

export function createRoutes(profile: HostProfile, base: ApiBase): HostRoutes {
  return profile === "service" ? serviceRoutes(base) : nextRoutes(base);
}

export function routesForBase(base: ApiBase): HostRoutes {
  return createRoutes(resolveHostProfile(base.basePath), base);
}

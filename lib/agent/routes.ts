// 宿主路由表：同一 AgentClient 接口对两种宿主生成各自的 URL。
// Next 宿主保留历史形态；Service 使用版本化的 REST 形态（/v1）。
// 路由由「基址 + profile」决定，不读全局状态，因此每个 Client 可以指向不同环境。

export type HostProfile = "next" | "service";

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

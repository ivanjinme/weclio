// 独立 Service 路由表：仅由显式基址决定，不读全局状态。

/** 历史 UI 路径只在客户端转换，Service 不保留 Next 别名。 */
export function resolveApiPath(path: string, method = "GET"): string {
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

export function validateServiceBasePath(basePath: string): void {
  if (!basePath.startsWith("/") || basePath.startsWith("//") || /[?#\\]/.test(basePath)) {
    throw new Error(`basePath must start with "/" and contain only a path: ${basePath}`);
  }
  const normalized = new URL(basePath, "http://agent.invalid").pathname;
  if (/^\/api(?:\/|$)/i.test(decodeURIComponent(normalized))) {
    throw new Error("The retired /api backend is not supported; select an Agent Service");
  }
}

export function createRoutes(base: ApiBase): HostRoutes {
  validateServiceBasePath(base.basePath);
  return {
    commands: (sessionId) => join(base, `/sessions/${encode(sessionId)}/commands`),
    events: (sessionId, cwd) => join(base, `/sessions/${encode(sessionId)}/events${cwd ? `?cwd=${encode(cwd)}` : ""}`),
    runningEvents: () => join(base, "/events"),
    state: (sessionId) => join(base, `/sessions/${encode(sessionId)}/state`),
  };
}

export function routesForBase(base: ApiBase): HostRoutes {
  return createRoutes(base);
}

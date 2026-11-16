import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "../models-cache";
import { createOAuthLoginOptions } from "../oauth-login-options";
import { createManualLoginToken } from "../oauth-login-token";
import { AgentProtocolError } from "./protocol/validate";

// Provider OAuth 登录：宿主无关的登录编排。
// 传输（SSE / IPC）由宿主决定，这里只负责事件与手动回调。

export type OAuthClientEvent =
  | { type: "auth"; url: string; instructions: string | null; token: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { type: "select_request"; message: string; options: unknown; token: string }
  | { type: "prompt_request"; message: string; placeholder: string | null; token: string }
  | { type: "progress"; message: string }
  | { type: "success" }
  | { type: "cancelled" }
  | { type: "error"; message: string; code?: string };

export interface OAuthLoginHandle {
  /** 登录结束后 resolve（成功、失败或取消都走事件，不 reject）。 */
  readonly done: Promise<void>;
  /** 取消登录：拒绝挂起的手动输入并中止 SDK 流程。 */
  abort(): void;
}

type PendingInput = {
  provider: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

export interface OAuthLoginManager {
  /** 启动一次登录；事件通过 emit 送达宿主。 */
  start(provider: string, emit: (event: OAuthClientEvent) => void): OAuthLoginHandle;
  /** 浏览器回填授权码或跳转 URL。 */
  submit(token: string, code: string): void;
  /** 当前挂起的手动输入数量（诊断与测试用）。 */
  pendingCount(): number;
}

export function createOAuthLoginManager(): OAuthLoginManager {
  const registry = new Map<string, PendingInput>();

  function start(provider: string, emit: (event: OAuthClientEvent) => void): OAuthLoginHandle {
    const abort = new AbortController();
    const activeTokens = new Set<string>();
    let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

    const createClientInputRequest = () => {
      const token = createManualLoginToken(provider);
      activeTokens.add(token);
      const promise = new Promise<string>((resolve, reject) => {
        registry.set(token, {
          provider,
          resolve: (value) => { activeTokens.delete(token); registry.delete(token); resolve(value); },
          reject: (error) => { activeTokens.delete(token); registry.delete(token); reject(error); },
        });
      });
      return { token, promise };
    };

    // auth_url 与随后的 manual_code 复用同一 token，浏览器只需回填一次。
    const getManualInputRequest = () => {
      if (!pendingManualRequest) {
        pendingManualRequest = createClientInputRequest();
        pendingManualRequest.promise
          .finally(() => { pendingManualRequest = undefined; })
          .catch(() => {});
      }
      return pendingManualRequest;
    };

    const cleanup = () => {
      for (const token of activeTokens) {
        registry.get(token)?.reject(new Error("Login cancelled"));
        registry.delete(token);
      }
      activeTokens.clear();
    };

    const done = (async () => {
      let loginOptions: ReturnType<typeof createOAuthLoginOptions> | undefined;
      let oauthSucceeded = false;
      let loginError: Error | undefined;
      let errorCode: string | undefined;
      try {
        const modelRuntime = await ModelRuntime.create();
        if (!modelRuntime.getProvider(provider)?.auth.oauth) {
          throw new AgentProtocolError("invalid_argument", `Unknown provider: ${provider}`);
        }
        loginOptions = createOAuthLoginOptions();
        await modelRuntime.login(provider, "oauth", {
          prompt: async (prompt: AuthPrompt) => {
            const request = prompt.type === "manual_code" ? getManualInputRequest() : createClientInputRequest();
            if (prompt.type === "select") {
              emit({ type: "select_request", message: prompt.message, options: prompt.options, token: request.token });
            } else {
              emit({
                type: "prompt_request",
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                token: request.token,
              });
            }
            return request.promise;
          },
          notify: (event: AuthEvent) => {
            if (event.type === "auth_url") {
              const request = getManualInputRequest();
              emit({
                type: "auth",
                url: event.url,
                instructions: event.instructions ?? null,
                token: request.token,
              });
            } else if (event.type === "device_code") {
              emit({
                type: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds ?? null,
                expiresInSeconds: event.expiresInSeconds ?? null,
              });
            } else {
              emit({ type: "progress", message: event.message });
            }
          },
          signal: abort.signal,
        }, loginOptions.options);

        oauthSucceeded = true;
        invalidateModelsCache();
      } catch (error) {
        loginError = error instanceof Error ? error : new Error(String(error));
      } finally {
        cleanup();
        try {
          await loginOptions?.flush();
        } catch (error) {
          // 授权失败或取消时保留原始原因；成功后的本地保存失败单独反馈。
          if (!loginError) {
            loginError = oauthSucceeded
              ? new Error("OAuth authorization succeeded, but the device ID could not be saved locally", { cause: error })
              : error instanceof Error ? error : new Error(String(error));
            if (oauthSucceeded) errorCode = "device_id_persistence_failed";
          } else {
            console.error("Failed to flush OAuth login settings", error);
          }
        }
        if (loginError?.message === "Login cancelled") emit({ type: "cancelled" });
        else if (loginError) emit({ type: "error", message: loginError.message, ...(errorCode ? { code: errorCode } : {}) });
        else emit({ type: "success" });
      }
    })();

    return {
      done,
      abort() {
        cleanup();
        abort.abort();
      },
    };
  }

  function submit(token: string, code: string): void {
    if (typeof token !== "string" || !token || typeof code !== "string" || !code) {
      throw new AgentProtocolError("invalid_argument", "token and code required");
    }
    const pending = registry.get(token);
    if (!pending) throw new AgentProtocolError("not_found", "No pending login for token");
    // token 形如 "<provider>-<uuid>"，必须与挂起登录的 provider 一致。
    if (!token.startsWith(`${pending.provider}-`)) {
      throw new AgentProtocolError("invalid_argument", "Token does not match provider");
    }
    pending.resolve(code);
    registry.delete(token);
  }

  return {
    start,
    submit,
    pendingCount: () => registry.size,
  };
}

declare global {
  var __weclioOAuthLoginManager: OAuthLoginManager | undefined;
}

/** Next 热更新后仍复用同一份挂起登录状态。 */
export function getDefaultOAuthLoginManager(): OAuthLoginManager {
  return globalThis.__weclioOAuthLoginManager ??= createOAuthLoginManager();
}

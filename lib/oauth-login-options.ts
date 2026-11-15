import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Share pi's persistent installation device ID with the ChatGPT OAuth flow. */
export function createOAuthLoginOptions(agentDir: string = getAgentDir()) {
  const settings = SettingsManager.create(agentDir, agentDir);
  let deviceIdRequested = false;
  return {
    options: {
      getDeviceId: () => {
        deviceIdRequested = true;
        return settings.getOrCreateDeviceId();
      },
    },
    flush: async () => {
      await settings.flush();
      // 仅在登录请求了设备 ID 时检查 global 错误，其他提供商和 project 设置不受影响。
      const errors = settings.drainErrors().filter(({ scope }) => deviceIdRequested && scope === "global");
      if (errors.length > 0) {
        throw new AggregateError(errors.map(({ error }) => error), "Failed to save OAuth device ID locally");
      }
    },
  };
}

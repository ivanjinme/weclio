import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Share pi's persistent installation device ID with the ChatGPT OAuth flow. */
export function createOAuthLoginOptions(agentDir: string = getAgentDir()) {
  const settings = SettingsManager.create(agentDir, agentDir);
  return {
    options: { getDeviceId: () => settings.getOrCreateDeviceId() },
    flush: async () => {
      await settings.flush();
      // 设备 ID 仅保存在 global 设置中，project 错误不影响其持久化。
      const errors = settings.drainErrors().filter(({ scope }) => scope === "global");
      if (errors.length > 0) {
        throw new AggregateError(errors.map(({ error }) => error), "Failed to save OAuth device ID locally");
      }
    },
  };
}

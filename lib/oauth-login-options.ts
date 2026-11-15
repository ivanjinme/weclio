import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Share pi's persistent installation device ID with the ChatGPT OAuth flow. */
export function createOAuthLoginOptions(agentDir: string = getAgentDir()) {
  const settings = SettingsManager.create(agentDir, agentDir);
  return {
    options: { getDeviceId: () => settings.getOrCreateDeviceId() },
    flush: async () => {
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length > 0) {
        throw new AggregateError(errors.map(({ error }) => error), "Failed to save OAuth device ID locally");
      }
    },
  };
}

import type { Locale } from "@/lib/i18n/types";

export interface DesktopUpdateState {
  status: "idle" | "checking" | "downloading" | "downloaded" | "error";
  version?: string;
  progress?: number;
  /** error 状态下的可读原因，用于 title 提示和排障。 */
  reason?: string;
}

export interface DesktopUpdateBridge {
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  restartUpdate(locale: Locale): Promise<void>;
  checkForUpdates?(): Promise<void>;
  getAgentService?(): Promise<SelectedAgentService>;
}

/** 宿主下发的 Agent Service 连接信息；凭据不进入静态资产或 URL。 */
export interface SelectedAgentService {
  baseUrl: string;
  token: string;
}

declare global {
  interface Window {
    weclioDesktop?: DesktopUpdateBridge;
  }
}

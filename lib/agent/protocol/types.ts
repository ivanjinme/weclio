// Agent Service 公共 DTO。
// 客户端与服务端共享，禁止依赖 SDK、Node、Next 或 Electron 类型。

export interface AgentImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "skill"; name: string }
  | { type: "file"; path: string };

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  source: string;
}

export type ToolPreset = "none" | "default" | "full";

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export interface AgentState {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  model?: { id: string; provider: string };
  messageCount: number;
  pendingMessageCount: number;
  queuedMessages: QueuedMessages;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt: string;
  thinkingLevel: string;
  extensionStatuses: ExtensionStatusItem[];
  extensionWidgets: ExtensionWidgetItem[];
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export interface SessionTreeEntry {
  id: string;
  type: string;
  message?: { role: string; content?: unknown };
}

/** 仅包含分支标签所需的文本预览，不用于回放。 */
export interface SessionTreeEntryPreview extends SessionTreeEntry {
  message?: { role: string; content: string };
}

export interface SessionTreeNode<Entry extends SessionTreeEntry = SessionTreeEntry> {
  entry: Entry;
  children: SessionTreeNode<Entry>[];
  label?: string;
  labelTimestamp?: string;
  compressedEntryIds?: string[];
}

// 只声明客户端消费的压缩结果字段，不将 SDK 的持久化结构带进协议。
export interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

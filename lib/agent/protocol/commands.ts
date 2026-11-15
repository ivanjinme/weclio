import type {
  AgentState,
  CompactCommandResult,
  ComposerPart,
  ExtensionStatusItem,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  QueuedMessages,
  SlashCommandInfo,
  ToolEntry,
  ToolPreset,
} from "./types";
import type { AgentImage } from "./types";

export type { AgentImage, AgentState, CompactCommandResult, ComposerPart, ExtensionStatusItem, ExtensionUiResponse, ExtensionWidgetItem, QueuedMessages, SlashCommandInfo, ToolEntry, ToolPreset };

export type AgentCommand =
  | { type: "prompt"; message: string; images?: AgentImage[]; parts?: ComposerPart[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: AgentImage[]; parts?: ComposerPart[] }
  | { type: "follow_up"; message: string; images?: AgentImage[]; parts?: ComposerPart[] }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "get_tools" }
  | { type: "get_commands" }
  | { type: "clear_queue" }
  | { type: "reload" }
  | { type: "abort_compaction" }
  | { type: "abort_bash" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "fork"; entryId: string; includeEntry?: boolean }
  | { type: "navigate_tree"; targetId: string }
  | { type: "navigate_before"; entryId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_session_name"; name: string }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "set_tools"; preset: ToolPreset; toolNames?: string[] }
  | { type: "set_tools"; toolNames: string[]; preset?: never }
  | ExtensionUiResponse
  | { type: "extension_ui_input"; id: string; data: string }
  | { type: "bash"; command: string; excludeFromContext?: boolean };

export interface AgentCommandResults {
  prompt: null;
  steer: null;
  follow_up: null;
  abort: null;
  get_state: AgentState;
  get_tools: ToolEntry[];
  get_commands: { commands: SlashCommandInfo[] };
  clear_queue: QueuedMessages;
  reload: { success: true };
  abort_compaction: null;
  abort_bash: null;
  set_model: { id: string; provider: string };
  fork: { cancelled: true } | { cancelled: false; newSessionId: string };
  navigate_tree: { cancelled: boolean };
  navigate_before: { cancelled: boolean; targetId: string };
  set_thinking_level: null;
  compact: CompactCommandResult;
  set_session_name: null;
  set_auto_compaction: null;
  set_auto_retry: null;
  set_tools: null;
  extension_ui_response: null;
  extension_ui_input: null;
  bash: {
    output: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string;
  };
}

export type AgentCommandResult<C extends AgentCommand> = AgentCommandResults[C["type"]];

import type { AgentCommand, ComposerPart, ToolPreset } from "./commands";
import type { AgentImage } from "./types";

export type AgentProtocolErrorCode =
  | "invalid_command"
  | "invalid_argument"
  | "invalid_response"
  | "session_not_found"
  | "command_failed"
  | "http_error"
  | "unauthorized"
  | "forbidden_origin"
  | "payload_too_large"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "bad_gateway";

// 统一的客户端可见错误：code 供程序判断，message 供展示，requestId 供日志关联。
export class AgentProtocolError extends Error {
  readonly code: AgentProtocolErrorCode;
  readonly requestId?: string;

  constructor(code: AgentProtocolErrorCode, message: string, options?: { requestId?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentProtocolError";
    this.code = code;
    this.requestId = options?.requestId;
  }
}

const COMMAND_TYPES = new Set([
  "prompt", "steer", "follow_up", "abort", "get_state", "get_tools", "get_commands",
  "clear_queue", "reload", "abort_compaction", "abort_bash", "set_model", "fork",
  "navigate_tree", "navigate_before", "set_thinking_level", "compact", "set_session_name",
  "set_auto_compaction", "set_auto_retry", "set_tools", "extension_ui_response",
  "extension_ui_input", "bash",
]);

const TOOL_PRESETS = new Set<ToolPreset>(["none", "default", "full"]);

const ERROR_CODES = new Set<AgentProtocolErrorCode>([
  "invalid_command", "invalid_argument", "invalid_response", "session_not_found", "command_failed",
  "http_error", "unauthorized", "forbidden_origin", "payload_too_large", "not_found", "forbidden", "conflict", "bad_gateway",
]);

export function isAgentProtocolErrorCode(value: unknown): value is AgentProtocolErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value as AgentProtocolErrorCode);
}

function invalid(message: string): never {
  throw new AgentProtocolError("invalid_argument", message);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AgentProtocolError("invalid_command", "Command must be a JSON object");
  }
  return input as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) invalid(`${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${key} must be a string`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${key} must be a boolean`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(`${key} must be an array of strings`);
  return value;
}

function optionalImages(record: Record<string, unknown>): AgentImage[] | undefined {
  const value = record.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid("images must be an array");
  for (const image of value) {
    if (typeof image !== "object" || image === null) invalid("images must contain objects");
    const entry = image as Record<string, unknown>;
    if (entry.type !== "image" || typeof entry.data !== "string" || typeof entry.mimeType !== "string") {
      invalid("images entries must be {type:'image',data,mimeType}");
    }
  }
  return value as AgentImage[];
}

function optionalParts(record: Record<string, unknown>): ComposerPart[] | undefined {
  const value = record.parts;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid("parts must be an array");
  for (const part of value) {
    if (typeof part !== "object" || part === null) invalid("parts must contain objects");
    const entry = part as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") continue;
    if (entry.type === "skill" && typeof entry.name === "string") continue;
    if (entry.type === "file" && typeof entry.path === "string") continue;
    invalid("parts entries must be text, skill or file parts");
  }
  return value as ComposerPart[];
}

function parseMessageCommand(record: Record<string, unknown>): { message: string; images?: AgentImage[]; parts?: ComposerPart[] } {
  const images = optionalImages(record);
  const parts = optionalParts(record);
  return {
    message: requiredString(record, "message"),
    ...(images ? { images } : {}),
    ...(parts ? { parts } : {}),
  };
}

function parseExtensionUiResponse(record: Record<string, unknown>): AgentCommand {
  const id = requiredString(record, "id");
  if (record.cancelled === true) return { type: "extension_ui_response", id, cancelled: true };
  if (typeof record.confirmed === "boolean") return { type: "extension_ui_response", id, confirmed: record.confirmed };
  if (typeof record.value === "string") return { type: "extension_ui_response", id, value: record.value };
  throw new AgentProtocolError("invalid_argument", "extension_ui_response requires value, confirmed or cancelled");
}

function parseToolsCommand(record: Record<string, unknown>): AgentCommand {
  const preset = record.preset;
  const toolNames = optionalStringArray(record, "toolNames");
  if (preset === undefined && toolNames === undefined) invalid("set_tools requires preset or toolNames");
  if (preset !== undefined && (typeof preset !== "string" || !TOOL_PRESETS.has(preset as ToolPreset))) {
    invalid(`preset must be one of ${[...TOOL_PRESETS].join(", ")}`);
  }
  return preset === undefined
    ? { type: "set_tools", toolNames: toolNames ?? [] }
    : { type: "set_tools", preset: preset as ToolPreset, ...(toolNames ? { toolNames } : {}) };
}

// 未知字段不报错也不参与校验；新增字段必须同时更新本函数、契约文档与测试。
export function parseAgentCommand(input: unknown): AgentCommand {
  const record = asRecord(input);
  const type = record.type;
  if (typeof type !== "string" || !COMMAND_TYPES.has(type)) {
    throw new AgentProtocolError("invalid_command", `Unsupported command: ${String(type)}`);
  }

  switch (type) {
    case "prompt": {
      const streamingBehavior = record.streamingBehavior;
      if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
        invalid("streamingBehavior must be steer or followUp");
      }
      return {
        type,
        ...parseMessageCommand(record),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      };
    }
    case "steer":
    case "follow_up":
      return { type, ...parseMessageCommand(record) };
    case "get_state":
    case "get_tools":
    case "get_commands":
    case "clear_queue":
    case "reload":
    case "abort":
    case "abort_compaction":
    case "abort_bash":
      return { type };
    case "set_model":
      return { type, provider: requiredString(record, "provider"), modelId: requiredString(record, "modelId") };
    case "fork": {
      const includeEntry = optionalBoolean(record, "includeEntry");
      return { type, entryId: requiredString(record, "entryId"), ...(includeEntry === undefined ? {} : { includeEntry }) };
    }
    case "navigate_tree":
      return { type, targetId: requiredString(record, "targetId") };
    case "navigate_before":
      return { type, entryId: requiredString(record, "entryId") };
    case "set_thinking_level":
      return { type, level: requiredString(record, "level") };
    case "compact": {
      const customInstructions = optionalString(record, "customInstructions");
      return { type, ...(customInstructions === undefined ? {} : { customInstructions }) };
    }
    case "set_session_name":
      return { type, name: requiredString(record, "name") };
    case "set_auto_compaction":
    case "set_auto_retry": {
      const enabled = record.enabled;
      if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
      return { type, enabled };
    }
    case "set_tools":
      return parseToolsCommand(record);
    case "extension_ui_response":
      return parseExtensionUiResponse(record);
    case "extension_ui_input":
      return { type, id: requiredString(record, "id"), data: requiredString(record, "data") };
    case "bash": {
      const excludeFromContext = optionalBoolean(record, "excludeFromContext");
      return { type, command: requiredString(record, "command"), ...(excludeFromContext === undefined ? {} : { excludeFromContext }) };
    }
    default:
      throw new AgentProtocolError("invalid_command", `Unsupported command: ${type}`);
  }
}

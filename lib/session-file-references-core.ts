import type { SessionEntry, ToolResultMessage } from "./types";

// Only locally executed coding tools can authorize paths from their result text.
// Remote MCP and extension results can contain attacker-controlled strings.
const CODING_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function hasReferenceBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function containsExactPathReference(text: string, filePath: string): boolean {
  const target = normalizeSlashes(filePath);
  const targets = target.startsWith("/") ? [target, `file://${target}`] : [target];
  const haystacks = new Set([normalizeSlashes(text), normalizeSlashes(safeDecode(text))]);

  for (const haystack of haystacks) {
    for (const t of targets) {
      let index = haystack.indexOf(t);
      while (index !== -1) {
        const before = index === 0 ? "" : haystack[index - 1];
        const afterIndex = index + t.length;
        if ((index === 0 || !isPathChar(before)) && hasReferenceBoundaryAfter(haystack, afterIndex)) {
          return true;
        }
        index = haystack.indexOf(t, index + 1);
      }
    }
  }

  return false;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, out);
}

function recordField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** For untrusted tool results, recognize only framework-managed spill paths
 * and arguments sent to actual nested coding tools, never arbitrary result text.
 */
function collectUntrustedToolResultStrings(message: ToolResultMessage, out: string[]): void {
  const fullOutputPath = recordField(message.details, "fullOutputPath");
  if (typeof fullOutputPath === "string") out.push(fullOutputPath);

  const nestedCalls = recordField(recordField(message, "nestedCalls"), "calls");
  if (!Array.isArray(nestedCalls)) return;
  for (const call of nestedCalls) {
    const name = recordField(call, "name");
    if (typeof name === "string" && CODING_TOOL_NAMES.has(name)) {
      collectStrings(recordField(call, "arguments"), out);
    }
  }
}

function collectEntryStrings(entry: SessionEntry, out: string[]): void {
  if (entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE) return;
  // A context edit can reintroduce external tool output into stored context.
  if ((entry as { type: string }).type === "context_edit") return;
  if (entry.type === "message") {
    if (entry.message.role === "system") return;
    if (entry.message.role === "toolResult" && !CODING_TOOL_NAMES.has(entry.message.toolName ?? "")) {
      collectUntrustedToolResultStrings(entry.message, out);
      return;
    }
  }
  collectStrings(entry, out);
}

export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    const strings: string[] = [];
    collectEntryStrings(entry, strings);
    if (strings.some((text) => containsExactPathReference(text, filePath))) return true;
  }
  return false;
}

export function isBashOutputPathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  return entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "bashExecution"
    && entry.message.fullOutputPath === filePath
  ));
}

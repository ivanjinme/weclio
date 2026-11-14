import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-file-references-core.ts");
}

test("detects exact external file paths referenced in session entries", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [/home/me/.codex/config.toml:12](/home/me/.codex/config.toml:12)",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), true);
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See /home/me/.codex/config.toml.bak",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), false);
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntry]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});

function messageEntry(message) {
  return {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}
function toolResult(toolName, text, extra = {}) {
  return messageEntry({
    role: "toolResult",
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    ...extra,
  });
}
const PRIVATE_PATH = "/home/me/.ssh/id_ed25519";

test("system messages and external tool result text do not authorize files", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, [
    messageEntry({ role: "system", content: `Tools may read ${PRIVATE_PATH}` }),
  ]), false);

  for (const toolName of ["mcp__filesystem__read", "codemode", "web_search", "extension_tool", undefined]) {
    assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, [
      toolResult(toolName, `External output mentions ${PRIVATE_PATH}`, {
        details: { opaque: { path: PRIVATE_PATH } },
      }),
    ]), false, String(toolName));
  }
});

test("user/assistant messages and local coding tools retain file references", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  for (const message of [
    { role: "user", content: `Open ${PRIVATE_PATH}` },
    { role: "assistant", content: [{ type: "text", text: `See ${PRIVATE_PATH}` }] },
  ]) {
    assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, [messageEntry(message)]), true);
  }
  for (const toolName of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]) {
    assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, [toolResult(toolName, PRIVATE_PATH)]), true, toolName);
  }
});

test("third-party results authorize only designated output paths and nested coding arguments", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/weclio-tool-output.txt";
  const argumentPath = "/home/me/notes.md";
  const entries = [toolResult("codemode", `Untrusted ${PRIVATE_PATH}`, {
    details: { fullOutputPath: outputPath, arbitrary: PRIVATE_PATH },
    nestedCalls: {
      calls: [
        { name: "read", arguments: { path: argumentPath } },
        { name: "mcp__files__read", arguments: { path: PRIVATE_PATH }, error: PRIVATE_PATH },
      ],
    },
  })];
  assert.equal(isFilePathReferencedByEntries(outputPath, entries), true);
  assert.equal(isFilePathReferencedByEntries(argumentPath, entries), true);
  assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, entries), false);
});

test("context edits and codemode stores cannot re-authorize untrusted paths", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const base = { id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
  const entries = [
    { ...base, type: "custom", customType: "codemode-store", data: { saved: PRIVATE_PATH } },
    { ...base, type: "context_edit", replacement: { text: PRIVATE_PATH } },
  ];
  assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, entries), false);
});

test("a model-issued tool call argument can authorize a path", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entry = messageEntry({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: PRIVATE_PATH } }],
  });
  assert.equal(isFilePathReferencedByEntries(PRIVATE_PATH, [entry]), true);
});

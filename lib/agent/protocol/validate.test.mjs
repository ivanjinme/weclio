import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentProtocolError, parseAgentCommand } = await jiti.import("./validate.ts");
const { PROTOCOL_VERSION, negotiateProtocol } = await jiti.import("./version.ts");

function rejectsWithCode(input, code) {
  assert.throws(() => parseAgentCommand(input), (error) => {
    assert.ok(error instanceof AgentProtocolError, "expected AgentProtocolError");
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts and normalizes every supported command", () => {
  const valid = [
    [{ type: "prompt", message: "hi" }, { type: "prompt", message: "hi" }],
    [{ type: "prompt", message: "hi", streamingBehavior: "steer" }, { type: "prompt", message: "hi", streamingBehavior: "steer" }],
    [{ type: "steer", message: "hi", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, null],
    [{ type: "follow_up", message: "hi", parts: [{ type: "text", text: "a" }, { type: "skill", name: "s" }, { type: "file", path: "p" }] }, null],
    [{ type: "abort" }, { type: "abort" }],
    [{ type: "get_state" }, { type: "get_state" }],
    [{ type: "get_tools" }, { type: "get_tools" }],
    [{ type: "get_commands" }, { type: "get_commands" }],
    [{ type: "clear_queue" }, { type: "clear_queue" }],
    [{ type: "reload" }, { type: "reload" }],
    [{ type: "abort_compaction" }, { type: "abort_compaction" }],
    [{ type: "abort_bash" }, { type: "abort_bash" }],
    [{ type: "set_model", provider: "p", modelId: "m" }, null],
    [{ type: "fork", entryId: "e", includeEntry: false }, { type: "fork", entryId: "e", includeEntry: false }],
    [{ type: "navigate_tree", targetId: "t" }, null],
    [{ type: "navigate_before", entryId: "e" }, null],
    [{ type: "set_thinking_level", level: "high" }, null],
    [{ type: "compact", customInstructions: "focus" }, { type: "compact", customInstructions: "focus" }],
    [{ type: "compact" }, { type: "compact" }],
    [{ type: "set_session_name", name: "n" }, null],
    [{ type: "set_auto_compaction", enabled: true }, { type: "set_auto_compaction", enabled: true }],
    [{ type: "set_auto_retry", enabled: false }, { type: "set_auto_retry", enabled: false }],
    [{ type: "set_tools", preset: "default" }, { type: "set_tools", preset: "default" }],
    [{ type: "set_tools", toolNames: ["read"] }, { type: "set_tools", toolNames: ["read"] }],
    [{ type: "extension_ui_response", id: "d", value: "v" }, { type: "extension_ui_response", id: "d", value: "v" }],
    [{ type: "extension_ui_response", id: "d", confirmed: true }, { type: "extension_ui_response", id: "d", confirmed: true }],
    [{ type: "extension_ui_response", id: "d", cancelled: true }, { type: "extension_ui_response", id: "d", cancelled: true }],
    [{ type: "extension_ui_input", id: "d", data: "x" }, { type: "extension_ui_input", id: "d", data: "x" }],
    [{ type: "bash", command: "ls", excludeFromContext: true }, { type: "bash", command: "ls", excludeFromContext: true }],
  ];

  for (const [input, expected] of valid) {
    const parsed = parseAgentCommand(input);
    assert.equal(parsed.type, input.type);
    if (expected) assert.deepEqual(parsed, expected);
  }
});

test("accepts empty message text only with an image attachment", () => {
  const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
  for (const type of ["prompt", "steer", "follow_up"]) {
    const command = { type, message: "", images };
    assert.deepEqual(parseAgentCommand(command), command);
    rejectsWithCode({ ...command, images: [] }, "invalid_argument");
    rejectsWithCode({ type, images }, "invalid_argument");
  }
});

test("rejects malformed envelopes and unsupported command names", () => {
  for (const input of [null, undefined, "abort", 42, [], [{ type: "abort" }]]) {
    rejectsWithCode(input, "invalid_command");
  }
  rejectsWithCode({}, "invalid_command");
  rejectsWithCode({ type: "" }, "invalid_command");
  rejectsWithCode({ type: "get_tool" }, "invalid_command");
});

test("rejects missing or ill-typed required fields", () => {
  rejectsWithCode({ type: "prompt" }, "invalid_argument");
  rejectsWithCode({ type: "prompt", message: 7 }, "invalid_argument");
  rejectsWithCode({ type: "prompt", message: "hi", streamingBehavior: "queue" }, "invalid_argument");
  rejectsWithCode({ type: "prompt", message: "hi", images: "nope" }, "invalid_argument");
  rejectsWithCode({ type: "prompt", message: "hi", images: [{ type: "image", data: "AA==" }] }, "invalid_argument");
  rejectsWithCode({ type: "prompt", message: "hi", parts: [{ type: "video", path: "p" }] }, "invalid_argument");
  rejectsWithCode({ type: "set_model", provider: "p" }, "invalid_argument");
  rejectsWithCode({ type: "fork" }, "invalid_argument");
  rejectsWithCode({ type: "navigate_tree" }, "invalid_argument");
  rejectsWithCode({ type: "set_auto_retry", enabled: "yes" }, "invalid_argument");
  rejectsWithCode({ type: "bash" }, "invalid_argument");
  rejectsWithCode({ type: "extension_ui_input", id: "d" }, "invalid_argument");
  rejectsWithCode({ type: "extension_ui_response", id: "d" }, "invalid_argument");
  rejectsWithCode({ type: "set_tools" }, "invalid_argument");
  rejectsWithCode({ type: "set_tools", preset: "all" }, "invalid_argument");
  rejectsWithCode({ type: "set_tools", toolNames: [1] }, "invalid_argument");
});

test("drops unknown fields instead of forwarding them to the service", () => {
  assert.deepEqual(parseAgentCommand({ type: "abort", extra: true }), { type: "abort" });
  assert.deepEqual(
    parseAgentCommand({ type: "set_thinking_level", level: "low", injected: { a: 1 } }),
    { type: "set_thinking_level", level: "low" },
  );
});

test("negotiates protocol major and minimum client version", () => {
  const ok = (protocol) => negotiateProtocol({ protocol });
  assert.deepEqual(ok({ version: PROTOCOL_VERSION, minClient: PROTOCOL_VERSION }), { ok: true });
  assert.equal(ok({ version: PROTOCOL_VERSION + 1, minClient: 1 }).ok, false);
  assert.equal(ok({ version: PROTOCOL_VERSION, minClient: PROTOCOL_VERSION + 1 }).ok, false);
  assert.equal(ok({ version: 0, minClient: 1 }).ok, false);
  assert.equal(ok({ version: 1.5, minClient: 1 }).ok, false);
  assert.match(ok({ version: 2, minClient: 1 }).reason, /protocol major/);
});

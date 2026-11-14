import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthSseWriter } from "./oauth-sse.ts";

test("OAuth SSE writer formats events and ignores progress after close", () => {
  const frames = [];
  let closeCount = 0;
  const controller = {
    enqueue: (data) => { frames.push(new TextDecoder().decode(data)); },
    close: () => { closeCount++; },
  };
  const writer = createOAuthSseWriter();
  writer.send(controller, { type: "success" });
  writer.close(controller);
  writer.send(controller, { type: "progress", message: "late" });
  writer.close(controller);
  assert.deepEqual(frames, ['data: {"type":"success"}\n\n']);
  assert.equal(closeCount, 1);
});

test("OAuth SSE writer swallows already-closed controller errors", () => {
  const controller = {
    enqueue: () => { throw new TypeError("Controller is already closed"); },
    close: () => { throw new TypeError("Controller is already closed"); },
  };
  const writer = createOAuthSseWriter();
  assert.doesNotThrow(() => writer.send(controller, { type: "progress" }));
  assert.doesNotThrow(() => writer.close(controller));
  const otherWriter = createOAuthSseWriter();
  assert.doesNotThrow(() => otherWriter.close(controller));
});

test("cancel marks the SSE writer closed without sending further events", () => {
  const writer = createOAuthSseWriter();
  writer.markClosed();
  assert.doesNotThrow(() => writer.send({
    enqueue: () => { throw new Error("send after cancel"); },
  }, { type: "progress" }));
});

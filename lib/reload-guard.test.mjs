import assert from "node:assert/strict";
import test from "node:test";
import { shouldRefuseDirectReload, extensionReloadBlockReason } from "./reload-guard.ts";

test("client reload blocks any running prompt or compaction", () => {
  assert.equal(shouldRefuseDirectReload(false, false), false);
  assert.equal(shouldRefuseDirectReload(true, false), true);
  assert.equal(shouldRefuseDirectReload(false, true), true);
});
test("extension command may reload while only its own prompt is active", () => {
  assert.equal(extensionReloadBlockReason(false, false, false), null);
  assert.match(extensionReloadBlockReason(true, false, false), /response to finish/);
  assert.match(extensionReloadBlockReason(false, true, false), /compaction/);
  assert.match(extensionReloadBlockReason(false, false, true), /compaction/);
});

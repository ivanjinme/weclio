import assert from "node:assert/strict";
import test from "node:test";
import { hasParentDirectorySegment } from "./path-security.ts";

test("rejects traversal segments without rejecting ordinary filename dots", () => {
  for (const path of ["/repo/child/../secret", "C:\\repo\\child\\..\\secret", "\\\\server\\share\\..\\secret"]) {
    assert.equal(hasParentDirectorySegment(path), true, path);
  }
  for (const path of ["/repo/.git/config", "/repo/..safe/file", "C:\\repo\\file.txt"]) {
    assert.equal(hasParentDirectorySegment(path), false, path);
  }
});

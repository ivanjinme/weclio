import assert from "node:assert/strict";
import test from "node:test";
import { encodeFilePathForApi } from "./file-paths.ts";

test("UNC host stays in the first encoded segment", () => {
  assert.equal(encodeFilePathForApi(String.raw`\\\\server\\share\\file.txt`), "%2F%2Fserver/share/file.txt");
  assert.equal(encodeFilePathForApi("//server/share/project/a.md"), "%2F%2Fserver/share/project/a.md");
});
test("regular POSIX and drive paths retain current encoding", () => {
  assert.equal(encodeFilePathForApi("/home/me/a b.md"), "home/me/a%20b.md");
  assert.equal(encodeFilePathForApi("C:/Users/me/test.txt"), "C%3A/Users/me/test.txt");
});

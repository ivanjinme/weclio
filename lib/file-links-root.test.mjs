import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalFileHref } from "./file-links.ts";

test("Windows drive roots cannot be crossed by parent links", () => {
  assert.equal(resolveLocalFileHref("file:///C:/../notes.txt", "C:/work"), "C:/notes.txt");
  assert.equal(resolveLocalFileHref("file:///C:/../../notes.txt", "C:/work"), "C:/notes.txt");
});
test("UNC server/share root cannot be crossed by parent links", () => {
  assert.equal(resolveLocalFileHref("file://server/share/../notes.txt", "/home/work"), "//server/share/notes.txt");
  assert.equal(resolveLocalFileHref("file://server/share/../../notes.txt", "/home/work"), "//server/share/notes.txt");
  assert.equal(resolveLocalFileHref("file://server/share/project/../notes.txt", "/home/work"), "//server/share/notes.txt");
});

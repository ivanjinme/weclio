import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalFileHref } from "./file-links.ts";

test("Windows drive roots cannot be crossed by parent links", () => {
  assert.equal(resolveLocalFileHref("file:///C:/../notes.txt", "C:/work"), "C:/notes.txt");
  assert.equal(resolveLocalFileHref("file:///C:/../../notes.txt", "C:/work"), "C:/notes.txt");
});
test("UNC server/share root cannot be crossed by parent links", () => {
  assert.equal(resolveLocalFileHref("\\\\server\\share\\..\\notes.txt", "/home/work"), "//server/share/notes.txt");
  assert.equal(resolveLocalFileHref("\\\\server\\share\\..\\..\\notes.txt", "/home/work"), "//server/share/notes.txt");
  assert.equal(resolveLocalFileHref("\\\\server\\share\\project\\..\\notes.txt", "/home/work"), "//server/share/notes.txt");
});

test("UNC file URLs follow standard URL parent normalization", () => {
  // 原生 UNC 路径保护共享根；file URL 先由 new URL 规范化，不保留共享根。
  assert.equal(resolveLocalFileHref("file://server/share/../notes.txt", "/home/work"), "//server/notes.txt");
  assert.equal(resolveLocalFileHref("file://server/share/../../notes.txt", "/home/work"), "//server/notes.txt");
  assert.equal(resolveLocalFileHref("file://server/share/project/../notes.txt", "/home/work"), "//server/share/notes.txt");
});

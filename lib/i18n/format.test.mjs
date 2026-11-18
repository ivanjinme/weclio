import assert from "node:assert/strict";
import test from "node:test";

import { interpolateMessage, translateMessage } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

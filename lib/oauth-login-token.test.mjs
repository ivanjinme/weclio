import assert from "node:assert/strict";
import test from "node:test";
import { createManualLoginToken } from "./oauth-login-token.ts";

test("manual OAuth tokens use unique cryptographically generated UUIDs", () => {
  const tokens = Array.from({ length: 100 }, () => createManualLoginToken("openai"));
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^openai-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(token.startsWith("other-provider-"), false);
  }
});

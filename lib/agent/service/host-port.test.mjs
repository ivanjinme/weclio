import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { isBrowserBlockedPort } = await createJiti(import.meta.url).import("./host.ts");

test("browser-blocked ports are recognised so automatic port selection can avoid them", () => {
  for (const port of [1, 25, 587, 6000, 6665, 6669, 10080]) assert.equal(isBrowserBlockedPort(port), true, String(port));
  for (const port of [80, 443, 8888, 49152, 65535]) assert.equal(isBrowserBlockedPort(port), false, String(port));
});

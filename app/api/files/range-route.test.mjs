import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weclio-byte-range-")));
const priorCache = globalThis.__piAllowedRootsCache;
test.after(() => {
  globalThis.__piAllowedRootsCache = priorCache;
  fs.rmSync(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET } = await jiti.import("./[...path]/route.ts");

test("rejects bytes=- but preserves valid start, end and suffix ranges", async () => {
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60000 };
  const file = path.join(root, "download.txt");
  fs.writeFileSync(file, "abcdef");
  const request = (range) => GET(new NextRequest("http://localhost/api/files/path?type=download", {
    headers: { range },
  }), {
    params: Promise.resolve({ path: file.replace(/\\/g, "/").split("/").filter(Boolean) }),
  });

  const invalid = await request("bytes=-");
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */6");
  for (const [range, content] of [["bytes=-2", "ef"], ["bytes=2-", "cdef"], ["bytes=1-3", "bcd"]]) {
    const res = await request(range);
    assert.equal(res.status, 206);
    assert.equal(await res.text(), content);
  }
});

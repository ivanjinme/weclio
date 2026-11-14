import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weclio-diff-auth-")));
const previousCache = globalThis.__piAllowedRootsCache;
test.after(() => {
  globalThis.__piAllowedRootsCache = previousCache;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { NextRequest } = await jiti.import("next/server");

function fixture() {
  const root = fs.mkdtempSync(path.join(base, "repo-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60000 };
  return root;
}
function request(cwd, filePath) {
  const url = new URL("http://localhost/api/git/diff");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("path", filePath);
  return GET(new NextRequest(url));
}

test("rejects a symlink or junction that points outside the authorized repo", async (t) => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("Symlink creation needs privileges");
    throw error;
  }
  assert.equal((await request(root, path.join(root, "linked", "secret.txt"))).status, 403);
  assert.equal((await request(root, path.join(root, "linked", "missing", "secret.txt"))).status, 403);
});

test("rejects explicit parent traversal even when the resolved path is inside the repo", async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "nested"));
  assert.equal((await request(root, root + path.sep + "nested" + path.sep + ".." + path.sep + "file.txt")).status, 403);
});

test("still serves diffs for a deleted tracked file with missing parent folders", async () => {
  const root = fixture();
  const dir = path.join(root, "nested");
  fs.mkdirSync(dir);
  const file = path.join(dir, "gone.txt");
  fs.writeFileSync(file, "original\\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  fs.unlinkSync(file);
  fs.rmdirSync(dir);
  const response = await request(root, file);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.supported, true);
  assert.equal(result.status, "deleted");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 授权 + git 子进程 + 索引缓存：使用临时仓库与允许根缓存，不触碰真实用户目录。
const base = mkdtempSync(join(tmpdir(), "weclio-git-index-"));
const previousRoots = globalThis.__piAllowedRootsCache;
test.after(() => {
  globalThis.__piAllowedRootsCache = previousRoots;
  rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const { gitDiff, gitStatus } = await jiti.import("./git-service.ts");
const { fileIndex } = await jiti.import("./file-index-service.ts");

function authorize(...roots) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
}

function reject(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function repo(name) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
  writeFileSync(join(root, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(root, "untracked.txt"), "new\n");
  authorize(root);
  return root;
}

test("git status reports repository state for an authorized directory", async () => {
  const root = repo("status");
  const status = await gitStatus(root);
  assert.equal(status.isGitRepository, true);
  assert.ok(status.files.some((file) => file.filePath.endsWith("tracked.txt")));
  assert.ok(status.files.some((file) => file.filePath.endsWith("untracked.txt")));
});

test("git status rejects relative, unauthorized and missing directories", async () => {
  const root = repo("auth");
  await reject(gitStatus("relative/path"), "invalid_argument");
  await reject(gitStatus(join(root, "missing")), "not_found");
  authorize(join(base, "elsewhere"));
  await reject(gitStatus(root), "forbidden");
});

test("git diff returns the tracked patch and rejects paths outside the roots", async () => {
  const root = repo("diff");
  const diff = await gitDiff(root, join(root, "tracked.txt"));
  assert.equal(diff.supported, true);
  assert.match(JSON.stringify(diff), /two/);

  await reject(gitDiff(root, "tracked.txt"), "invalid_argument");
  await reject(gitDiff(root, join(base, "outside.txt")), "forbidden");
  await reject(gitDiff(root, join(root, "..", "escape.txt")), "forbidden");
});

test("Git diff and line counts treat bracketed paths literally", async () => {
  const root = repo("literal");
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  const folder = join(root, "notes[1]");
  const selected = join(root, "[note].txt");
  const neighbor = join(root, "n.txt");
  const otherFolder = join(root, "notes1");
  mkdirSync(folder);
  mkdirSync(otherFolder);
  writeFileSync(selected, "before\n");
  writeFileSync(neighbor, "before\n");
  writeFileSync(join(folder, "n.txt"), "before\n");
  writeFileSync(join(otherFolder, "n.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "bracket fixtures");
  writeFileSync(selected, "before\nselected\n");
  writeFileSync(neighbor, "before\nneighbor\n");
  writeFileSync(join(folder, "n.txt"), "before\nwithin folder\nanother line\n");
  writeFileSync(join(otherFolder, "n.txt"), "before\nother folder\n");

  const diff = await gitDiff(root, selected);
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /^\+selected$/m);
  assert.doesNotMatch(diff.patch, /^\+(neighbor|other folder)$/m);
  assert.equal((diff.patch.match(/^diff --git /gm) ?? []).length, 1);
  assert.equal((await gitStatus(folder)).additions, 2);
});

test("Git and file index preserve trailing spaces in authorized paths", { skip: process.platform === "win32" }, async () => {
  const root = repo("trailing folder ");
  const file = join(root, "trailing.txt ");
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  writeFileSync(file, "before\n");
  git("add", ".");
  git("commit", "-qm", "trailing space fixture");
  writeFileSync(file, "before\nafter\n");

  const diff = await gitDiff(root, file);
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /^\+after$/m);
  assert.equal((await gitStatus(root)).repositoryRoot, root);
  assert.ok((await fileIndex(root)).files.includes("trailing.txt "));
});

test("git diff authorizes a deleted file through its nearest existing ancestor", async () => {
  const root = repo("deleted");
  execFileSync("git", ["-C", root, "rm", "-q", "--cached", "tracked.txt"]);
  const deleted = join(root, "tracked.txt");
  rmSync(deleted, { force: true });
  const diff = await gitDiff(root, deleted);
  assert.equal(typeof diff.supported, "boolean");
});

test("file index lists a non-git tree and searches against the full listing", async () => {
  const root = join(base, "walk");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(root, "readme.md"), "x");
  writeFileSync(join(root, "src", "deep", "target-file.ts"), "x");
  writeFileSync(join(root, "node_modules", "ignored", "noise.js"), "x");
  authorize(root);

  const listing = await fileIndex(root);
  assert.deepEqual(listing.files.sort(), ["readme.md", "src/deep/target-file.ts"]);
  assert.equal(listing.truncated, false);

  const search = await fileIndex(root, "target");
  assert.ok(search.matches.some((match) => match.path === "src/deep/target-file.ts"));
});

test("file index rejects unauthorized or missing directories", async () => {
  const root = join(base, "gate");
  mkdirSync(root, { recursive: true });
  await reject(fileIndex(root), "forbidden");
  authorize(root);
  await reject(fileIndex(join(root, "missing")), "not_found");
});

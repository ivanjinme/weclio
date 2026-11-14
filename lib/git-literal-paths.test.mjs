import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("a file diff does not expand brackets in the selected path", async () => {
  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url).import("./git-changes.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-literal-diff-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "core.fsmonitor", "false");
    git("config", "core.autocrlf", "false");
    for (const dir of ["notes[1]", "notes1"]) {
      fs.mkdirSync(path.join(root, dir));
      for (const name of ["[note].txt", "n.txt"]) fs.writeFileSync(path.join(root, dir, name), "before\n");
    }
    git("add", ".");
    git("-c", "user.name=Pi Web Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial files");
    for (const dir of ["notes[1]", "notes1"]) {
      fs.writeFileSync(path.join(root, dir, "[note].txt"), "selected\n");
      fs.writeFileSync(path.join(root, dir, "n.txt"), "unrelated\n");
    }
    const selected = path.join(root, "notes[1]", "[note].txt");
    const diff = await getGitFileDiff(root, selected);
    assert.equal(diff.supported, true);
    assert.match(diff.patch, /\+selected/);
    assert.doesNotMatch(diff.patch, /unrelated/);
    assert.equal((diff.patch.match(/^diff --git /gm) ?? []).length, 1);
    const status = await getGitStatus(path.join(root, "notes[1]"));
    assert.equal(status.additions, 2);
    assert.equal(status.deletions, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git status and diff preserve trailing spaces in a folder path", { skip: process.platform === "win32" }, async () => {
  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url).import("./git-changes.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-trailing-git-"));
  const repo = path.join(root, "trailing dir ");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "core.fsmonitor", "false");
    const file = path.join(repo, "file name .txt ");
    fs.writeFileSync(file, "before\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
    fs.writeFileSync(file, "after\n");
    const diff = await getGitFileDiff(repo, file);
    assert.equal(diff.supported, true);
    assert.match(diff.patch, /\+after/);
    const status = await getGitStatus(repo);
    assert.ok(status.files.some((item) => item.filePath === file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

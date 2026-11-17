import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("overwrites through a staged file and removes the staging directory", async (t) => {
  const { replaceUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-upload-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "important.txt");
  fs.writeFileSync(destination, "original");
  replaceUploadFile(destination, Buffer.from("replacement"));
  assert.equal(fs.readFileSync(destination, "utf8"), "replacement");
  assert.deepEqual(fs.readdirSync(root), ["important.txt"]);
});

test("a failed rename preserves the original upload and cleans staging", async (t) => {
  const { replaceUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-upload-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "important.txt");
  fs.writeFileSync(destination, "original");
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("simulated rename failure"); };
    assert.throws(() => replaceUploadFile(destination, Buffer.from("replacement")), /simulated rename failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(destination, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["important.txt"]);
});

test("overwriting preserves executable permission bits despite umask", { skip: process.platform === "win32" }, async (t) => {
  const { replaceUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-upload-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "script.sh");
  fs.writeFileSync(destination, "echo original\\n");
  fs.chmodSync(destination, 0o755);
  const oldMask = process.umask(0o077);
  try {
    replaceUploadFile(destination, Buffer.from("echo replacement\\n"));
  } finally {
    process.umask(oldMask);
  }
  assert.equal(fs.statSync(destination).mode & 0o777, 0o755);
});

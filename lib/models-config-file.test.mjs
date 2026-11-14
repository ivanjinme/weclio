import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readModelsJsonFile, writeModelsJsonFile } from "./models-config-file.ts";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weclio-models-safe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, target: path.join(dir, "models.json") };
}

test("missing models.json is empty, but malformed or truncated data is an error", (t) => {
  const { target } = fixture(t);
  assert.deepEqual(readModelsJsonFile(target), { providers: {} });
  for (const broken of ["", "{bad json", "[]", "null"]) {
    fs.writeFileSync(target, broken);
    assert.throws(() => readModelsJsonFile(target), /Invalid models.json/);
    assert.throws(() => writeModelsJsonFile(target, { providers: {} }), /Invalid models.json/);
    assert.equal(fs.readFileSync(target, "utf8"), broken);
  }
});

test("reads a UTF-8 BOM and preserves config on atomic save", (t) => {
  const { target } = fixture(t);
  fs.writeFileSync(target, "\uFEFF" + JSON.stringify({ providers: { local: { baseUrl: "http://localhost" } } }));
  assert.equal(readModelsJsonFile(target).providers.local.baseUrl, "http://localhost");
  writeModelsJsonFile(target, { providers: { local: { models: [] } } });
  assert.deepEqual(readModelsJsonFile(target), { providers: { local: { models: [] } } });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["models.json"]);
});

test("rename failure leaves existing models.json untouched", (t) => {
  const { target, dir } = fixture(t);
  const original = '{"providers":{"important":true}}';
  fs.writeFileSync(target, original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("simulated rename failure"); };
    assert.throws(() => writeModelsJsonFile(target, { providers: {} }), /simulated rename failure/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir), ["models.json"]);
});

test("preserves access mode across writes", { skip: process.platform === "win32" }, (t) => {
  const { target } = fixture(t);
  fs.writeFileSync(target, "{}");
  fs.chmodSync(target, 0o600);
  const old = process.umask(0o077);
  try { writeModelsJsonFile(target, { providers: {} }); }
  finally { process.umask(old); }
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

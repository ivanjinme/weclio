import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectDependencies, compileServiceSources, copyDependencyClosure } from "./service-build.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "weclio-service-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return root;
}
function file(root, name, content) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}
function pkg(root, name, metadata = {}, path = `node_modules/${name}`) {
  file(root, `${path}/package.json`, JSON.stringify({ name, version: "1.0.0", ...metadata }));
  return { [path]: { version: "1.0.0", integrity: "sha512-fixture" } };
}
function lock(root, packages) { file(root, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages })); }

test("Service ESM graph drops type-only imports and rewrites local aliases/extensionless imports", (t) => {
  const root = fixture(t);
  file(root, "lib/entry.ts", 'import type { X } from "next"; import { value } from "@/lib/value"; export { other } from "./other"; export const count: number = value; export async function load(){ return import("runtime/extra"); }');
  file(root, "lib/value.ts", 'import { readFileSync } from "node:fs"; export const value = readFileSync.length;');
  file(root, "lib/other.ts", 'export const other = 1;');
  const graph = compileServiceSources(root, ["lib/entry.ts"]);
  assert.equal(graph.output.size, 3);
  assert.deepEqual(graph.dependencies, ["runtime"]);
  const entry = graph.output.get("lib/entry.js");
  assert.match(entry, /from "\.\/value\.js"/);
  assert.match(entry, /from "\.\/other\.js"/);
  assert.doesNotMatch(entry, /next|: number|@\/lib/);
});

test("untraceable dynamic imports and host/UI imports fail rather than leaking into Service", (t) => {
  const root = fixture(t);
  for (const source of ['export const load = (x: string) => import(x);', 'import "electron-updater";', 'import "next";']) {
    file(root, "entry.ts", source);
    assert.throws(() => compileServiceSources(root, ["entry.ts"]), /Nonliteral|UI\/host/);
  }
});

test("runtime closure includes root dev-marked requirements, nested versions, optional and peer policy", (t) => {
  const root = fixture(t);
  const packages = {
    ...pkg(root, "a", { dependencies: { b: "1.0.0", string_decoder: "1.0.0" }, optionalDependencies: { absent: "1" }, peerDependencies: { peer: "1", optionalPeer: "1" }, peerDependenciesMeta: { optionalPeer: { optional: true } } }),
    ...pkg(root, "b"), ...pkg(root, "b", {}, "node_modules/a/node_modules/b"),
    ...pkg(root, "string_decoder"), ...pkg(root, "peer"),
  };
  packages["node_modules/a"].dev = true;
  lock(root, packages);
  const closure = collectDependencies(root, ["a"]);
  assert.deepEqual([...closure.packages.values()].map((p) => p.path).sort(), [
    "node_modules/a", "node_modules/a/node_modules/b", "node_modules/peer", "node_modules/string_decoder",
  ]);
  assert.deepEqual(closure.direct, { a: "1.0.0" });
});

test("missing required or lock-mismatched dependencies fail closed", (t) => {
  const root = fixture(t);
  lock(root, pkg(root, "a", { dependencies: { missing: "1" } }));
  assert.throws(() => collectDependencies(root, ["a"]), /Missing runtime dependency missing/);
  lock(root, { "node_modules/a": { version: "2.0.0" } });
  assert.throws(() => collectDependencies(root, ["a"]), /differs from package-lock/);
});

test("copy preserves TS loaders, WASM, templates and licenses, not only JavaScript files", async (t) => {
  const root = fixture(t);
  lock(root, pkg(root, "runtime"));
  for (const name of ["extension.ts", "binary.wasm", "template.html", "LICENSE", "worker.mjs", "data.map"]) file(root, `node_modules/runtime/${name}`, name);
  file(root, "node_modules/runtime/bundle.js.map", "unused source map");
  const destination = join(root, "artifact");
  await copyDependencyClosure(root, destination, ["runtime"]);
  for (const name of ["extension.ts", "binary.wasm", "template.html", "LICENSE", "worker.mjs", "data.map"]) {
    assert.equal(readFileSync(join(destination, "node_modules/runtime", name), "utf8"), name);
  }
  assert.throws(() => readFileSync(join(destination, "node_modules/runtime/bundle.js.map")), /ENOENT/);
});

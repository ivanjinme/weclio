import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeEnvironment, createServiceRuntimeEnvironment } from "./runtime.mjs";

const root = "C:\\Weclio\\resources\\runtime\\win-x64";

test("bundled tools are appended without changing the parent environment or user configuration", () => {
  const env = { Path: "C:\\Node;C:\\ExistingGit\\cmd", PI_CODING_AGENT_DIR: "C:\\agent", HOME: "C:\\user" };
  const before = { ...env };
  const result = createRuntimeEnvironment(root, env, "win32");
  assert.deepEqual(env, before);
  assert.equal(result.Path, undefined);
  assert.deepEqual(result.PATH.split(";"), ["C:\\Node", "C:\\ExistingGit\\cmd", `${root}\\tools`]);
  assert.equal(result.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_DIR);
  assert.equal(result.HOME, env.HOME);
  assert.equal(result.WECLIO_BASH_PATH, undefined);
});

test("Windows PATH variants and duplicate entries are merged into one key", () => {
  const result = createRuntimeEnvironment(root, { Path: "C:\\Node;", PATH: "c:\\node;C:\\Windows\\System32" }, "win32");
  assert.deepEqual(Object.keys(result), ["PATH"]);
  assert.deepEqual(result.PATH.split(";").slice(0, 2), ["C:\\Node", "C:\\Windows\\System32"]);
});

test("Service Node/npm precede user PATH without replacing user Git/Bash or leaking host flags", () => {
  const node = `${root}\\node`;
  const original = { Path: "C:\\OtherNode;C:\\Git\\cmd;C:\\Git\\bin", NODE_PATH: "C:\\repo\\node_modules", NODE_OPTIONS: "--require electron-hook", ELECTRON_RUN_AS_NODE: "1", NEXT_RUNTIME: "nodejs", __NEXT_TEST: "1", CUSTOM: "kept" };
  const env = createServiceRuntimeEnvironment(node, root, original, "win32");
  assert.deepEqual(env.PATH.split(";"), [node, "C:\\OtherNode", "C:\\Git\\cmd", "C:\\Git\\bin", `${root}\\tools`]);
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NEXT_RUNTIME", "__NEXT_TEST"]) assert.equal(env[key], undefined);
  assert.equal(env.CUSTOM, "kept");
  assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.WECLIO_BASH_PATH, undefined, "no shell substitution is introduced");
});

test("Windows case variants cannot retain Node/Electron/Next preload pollution", () => {
  const env = createServiceRuntimeEnvironment(`${root}\\node`, root, { Node_Options: "--require forbidden", node_path: "C:\\repo", electron_run_as_node: "1", __next_test: "pollution" }, "win32");
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("non-Windows development keeps its existing environment", () => {
  const env = { PATH: "/usr/bin:/bin" };
  assert.deepEqual(createRuntimeEnvironment(root, env, "linux"), env);
});

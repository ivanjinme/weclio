import assert from "node:assert/strict";
import { delimiter, dirname } from "node:path";
import test from "node:test";
import { resolveSystemNode } from "./system-node.mjs";

const nodeDir = dirname(process.execPath);

test("Desktop resolves an installed Node through absolute PATH entries without inheriting host flags", async () => {
  const env = { ...process.env, PATH: [".", `\"${nodeDir}\"`].join(delimiter), WECLIO_NODE_EXECUTABLE: "", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require=host-fixture-not-found", NODE_PATH: "host-fixture" };
  const systemNode = await resolveSystemNode({ env, toolsRoot: nodeDir });
  assert.equal(systemNode.executable.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(systemNode.version, process.versions.node);
  assert.equal(systemNode.env.PATH.split(delimiter)[0], nodeDir);
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"]) assert.equal(systemNode.env[key], undefined);
});

test("missing Node and an invalid explicit override do not fall back to Electron or cwd", async () => {
  await assert.rejects(resolveSystemNode({ env: { PATH: "." } }), /找不到系统 Node\.js/);
  await assert.rejects(resolveSystemNode({ env: { PATH: nodeDir, WECLIO_NODE_EXECUTABLE: "node" } }), /绝对路径/);
});

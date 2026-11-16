import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 资源包服务：使用临时 agentDir 与允许根；不安装任何外部包。
const root = mkdtempSync(join(tmpdir(), "weclio-plugins-service-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const jiti = createJiti(import.meta.url);
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const plugins = await jiti.import("./plugins-service.ts");
const { allowFileRoot } = await jiti.import("../file-access.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function reject(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("listing requires a cwd unless global-only", async () => {
  await reject(plugins.listPlugins({}), "invalid_argument");
  await reject(plugins.listPlugins({ cwd: "  " }), "invalid_argument");
});

test("listing rejects paths outside the allowed roots", async () => {
  await reject(plugins.listPlugins({ cwd: workspace }), "forbidden");
  allowFileRoot(workspace);
  const result = await plugins.listPlugins({ cwd: workspace });
  assert.ok(Array.isArray(result.packages));
  assert.equal(typeof result.totals.extensions, "number");
  assert.equal(result.projectResourcesLoaded, true);
});

test("global-only listing does not load project resources", async () => {
  const result = await plugins.listPlugins({ globalOnly: true });
  assert.equal(result.projectResourcesLoaded, false);
  assert.ok(Array.isArray(result.diagnostics));
});

test("mutation validates action, scope and source", async () => {
  await reject(plugins.mutatePlugins({}), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "install", scope: "project" }), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "install" }), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "remove" }), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "disable" }), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "explode" }), "invalid_argument");
});

test("project-scoped mutation requires trust and an allowed root", async () => {
  // 独立的目录：前面的用例已授权过 workspace，这里不能复用其状态。
  const project = join(root, "project-scope");
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "probe.js"), "export default () => {};");

  // 未授权路径先被拒绝，不会走到安装流程。
  await reject(plugins.mutatePlugins({ action: "install", source: "npm:fixture", scope: "project", cwd: project }), "forbidden");

  // 授权但仍未信任：项目级改动必须拒绝。
  allowFileRoot(project);
  await reject(
    plugins.mutatePlugins({ action: "install", source: "npm:fixture", scope: "project", cwd: project }),
    "forbidden",
  );
});

test("global mutation still validates the source before touching settings", async () => {
  await reject(plugins.mutatePlugins({ action: "install", source: "   " }), "invalid_argument");
  await reject(plugins.mutatePlugins({ action: "disable", source: "" }), "invalid_argument");
});

test("disabling an unknown package is a no-op that still returns the listing", async () => {
  const result = await plugins.mutatePlugins({ action: "disable", source: "npm:not-configured" });
  assert.ok(Array.isArray(result.packages));
  assert.equal(result.packages.some((entry) => entry.source === "npm:not-configured"), false);
});

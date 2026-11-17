import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "weclio-config-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const jiti = createJiti(import.meta.url);
const { resolveServiceConfig } = await jiti.import("./config.ts");
const { getDefaultWorkspacePath } = await jiti.import("../../default-workspace.ts");
test.after(() => rmSync(root, { recursive: true, force: true }));

test("default workspace matches Tasks identity independently of service state", () => {
  const config = resolveServiceConfig({ WECLIO_AGENT_STATE_DIR: join(root, "state") });
  assert.equal(config.workspace, getDefaultWorkspacePath("", root));
});

test("explicit service override wins over legacy workspace configuration", () => {
  const legacy = join(root, "legacy");
  assert.equal(resolveServiceConfig({ WECLIO_AGENT_STATE_DIR: join(root, "state"), PI_WEB_DEFAULT_CWD: legacy }).workspace, legacy);
  const explicit = join(root, "explicit");
  assert.equal(resolveServiceConfig({ WECLIO_AGENT_STATE_DIR: join(root, "state"), PI_WEB_DEFAULT_CWD: legacy, WECLIO_AGENT_WORKSPACE: explicit }).workspace, explicit);
});

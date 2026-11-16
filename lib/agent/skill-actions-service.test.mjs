import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Skills 操作：临时 agentDir 与工作区；不调用真正的 npx 或远端 API。
const root = mkdtempSync(join(tmpdir(), "weclio-skills-actions-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const jiti = createJiti(import.meta.url);
const { AgentProtocolError } = await jiti.import("./protocol/validate.ts");
const skills = await jiti.import("./skill-actions-service.ts");
const { allowFileRoot } = await jiti.import("../file-access.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function reject(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("listing requires cwd or global-only and honors allowed roots", async () => {
  await reject(skills.listSkills({}), "invalid_argument");
  await reject(skills.listSkills({ cwd: workspace }), "forbidden");
  allowFileRoot(workspace);
  const listed = await skills.listSkills({ cwd: workspace });
  assert.ok(Array.isArray(listed.skills));
  const globalList = await skills.listSkills({ globalOnly: true });
  assert.ok(Array.isArray(globalList.skills));
});

test("toggling model invocation validates the target file", async () => {
  await reject(skills.setSkillModelInvocation({}), "invalid_argument");
  await reject(skills.setSkillModelInvocation({ filePath: join(root, "missing.md") }), "not_found");
  await reject(
    skills.setSkillModelInvocation({ filePath: join(tmpdir(), "outside-skill.md"), disableModelInvocation: true }),
    "not_found",
  );
});

test("toggling rewrites only the frontmatter flag of an allowed skill", async () => {
  const dir = join(agentDir, "skills", "fixture-skill");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, ["---", "name: fixture-skill", "description: fixture", "---", "", "Body stays.", ""].join("\n"));

  await skills.setSkillModelInvocation({ filePath: file, disableModelInvocation: true });
  assert.match(readFileSync(file, "utf8"), /disable-model-invocation: true/);
  assert.match(readFileSync(file, "utf8"), /Body stays\./);

  await skills.setSkillModelInvocation({ filePath: file, disableModelInvocation: false });
  assert.doesNotMatch(readFileSync(file, "utf8"), /disable-model-invocation: true/);
  assert.match(readFileSync(file, "utf8"), /Body stays\./);
});

test("update requires a complete target and rejects unauthorized cwd", async () => {
  await reject(skills.updateSkill({}), "invalid_argument");
  await reject(skills.updateSkill({ package: "p" }), "invalid_argument");
  await reject(skills.updateSkill({ package: "p", scope: "project" }), "invalid_argument");
  await reject(
    skills.updateSkill({ package: "p", scope: "project", cwd: join(root, "not-allowed") }),
    "forbidden",
  );
});

test("update reports a missing installation instead of calling npx", async () => {
  await reject(skills.updateSkill({ package: "npm:unknown", scope: "global" }), "not_found");
});

test("install validates package, project cwd and trust before any subprocess", async () => {
  await reject(skills.installSkill({}), "invalid_argument");
  await reject(skills.installSkill({ package: "   " }), "invalid_argument");
  await reject(skills.installSkill({ package: "p", scope: "project" }), "invalid_argument");
  await reject(skills.installSkill({ package: "p", scope: "project", cwd: join(root, "nope") }), "forbidden");

  // 独立目录：授权但未信任的项目必须被拒绝，且不触达 npx。
  const project = join(root, "skill-project");
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "probe.js"), "export default () => {};");
  await reject(skills.installSkill({ package: "p", scope: "project", cwd: project }), "forbidden");
  allowFileRoot(project);
  await reject(skills.installSkill({ package: "p", scope: "project", cwd: project }), "forbidden");
});

test("checking updates pairs package with scope", async () => {
  await reject(skills.checkUpdates({ package: "p" }), "invalid_argument");
  await reject(skills.checkUpdates({ scope: "global" }), "invalid_argument");
  await reject(skills.checkUpdates({ package: "npm:unknown", scope: "global" }), "not_found");
});

test("search requires a query", async () => {
  await reject(skills.searchSkills({}), "invalid_argument");
  await reject(skills.searchSkills({ query: "  " }), "invalid_argument");
});

test("CLI search output parsing tolerates unknown formats", () => {
  assert.deepEqual(skills.parseSearchOutput("nothing useful here"), []);
  const parsed = skills.parseSearchOutput(
    ["owner/repo@skill  12K installs", "  └ https://skills.sh/owner/repo/skill", ""].join("\n"),
  );
  assert.deepEqual(parsed, [{
    package: "owner/repo@skill",
    installs: "12K installs",
    url: "https://skills.sh/owner/repo/skill",
  }]);
});

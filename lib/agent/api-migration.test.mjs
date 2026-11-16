import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A3.3 迁移清单：列出仍直接写死同源 /api 的前端调用点。
// 每迁移一处就从这份清单移除；清单为空时即可开启 Remote/静态 Desktop 入口。
const MIGRATION_INVENTORY = {
  "hooks/useAgentSession.ts": 9,
  "components/ModelsConfig.tsx": 12,
  "components/SessionSidebar.tsx": 11,
  "components/SkillsConfig.tsx": 5,
  "components/PluginsConfig.tsx": 2,
  "components/FileViewer.tsx": 2,
  "components/FileExplorer.tsx": 7,
  "components/ChatInput.tsx": 2,
  "components/MessageView.tsx": 1,
  "components/InitializedMarkdownEditor.tsx": 1,
  "components/MarkdownBody.tsx": 1,
  "components/DirectoryPicker.tsx": 1,
  "components/NewTaskProjectPicker.tsx": 3,
  "components/AppShell.tsx": 4,
  "hooks/useFileDraft.ts": 4,
  "hooks/useCodexUsage.ts": 1,
};

async function countDirectApiUsage(relativePath) {
  const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
  const fetchCalls = source.match(/fetch\(\s*[`"]\/api\//g) ?? [];
  const eventSources = source.match(/new EventSource\(\s*[`"]\/api\//g) ?? [];
  const hrefTemplates = source.match(/[`"]\/api\/files\//g) ?? [];
  return fetchCalls.length + eventSources.length + hrefTemplates.length;
}

test("the API base seam exists and defaults to same-origin", async () => {
  const source = await readFile(new URL("../api-base.ts", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_BASE_PATH = "\/api"/);
  assert.match(source, /export function apiUrl/);
  assert.match(source, /export function configureApiBase/);
});

test("the agent client follows the configured API base", async () => {
  const source = await readFile(new URL("../agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /getApiBase\(\)/);
});

test("direct same-origin /api call sites are tracked, not silently forgotten", async () => {
  const drifted = [];
  for (const [relativePath, expected] of Object.entries(MIGRATION_INVENTORY)) {
    const actual = await countDirectApiUsage(relativePath);
    if (actual > expected) drifted.push(`${relativePath}: ${actual} > ${expected}`);
  }
  // 新增直接调用会失败，提醒迁移者改走 apiUrl()/Agent Client。
  assert.deepEqual(drifted, []);
});

test("no migrated module re-introduces a hardcoded origin", async () => {
  for (const relativePath of ["lib/api-base.ts", "lib/agent-client.ts"]) {
    const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(source, /localhost:\d+/);
  }
});

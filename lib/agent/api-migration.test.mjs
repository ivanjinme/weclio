import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A3.3 迁移清单：列出仍直接写死同源 /api 的前端调用点。
// 每迁移一处就从这份清单移除；清单为空时即可开启 Remote/静态 Desktop 入口。
const MIGRATION_INVENTORY = {};

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

test("no UI module hardcodes a same-origin /api URL", async () => {
  const drifted = [];
  for (const [relativePath, expected] of Object.entries(MIGRATION_INVENTORY)) {
    const actual = await countDirectApiUsage(relativePath);
    if (actual > expected) drifted.push(`${relativePath}: ${actual} > ${expected}`);
  }
  // 全部迁移完成：任何新增的直接调用都会失败，必须改走 apiUrl()/Agent Client。
  assert.deepEqual(drifted, []);
  assert.deepEqual(Object.keys(MIGRATION_INVENTORY), []);
});

test("no migrated module re-introduces a hardcoded origin", async () => {
  for (const relativePath of ["lib/api-base.ts", "lib/agent-client.ts"]) {
    const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(source, /localhost:\d+/);
  }
});

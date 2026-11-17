import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

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

test("the API base seam requires explicit Service selection and rejects the retired backend", async () => {
  const { apiUrl, configureApiBase, getApiBase, isApiBaseConfigured } = await createJiti(import.meta.url).import("../api-base.ts");
  assert.equal(getApiBase().basePath, "/v1");
  assert.equal(isApiBaseConfigured(), false);
  assert.throws(() => apiUrl("/sessions"), /not configured/);
  assert.throws(() => configureApiBase({ basePath: "/api" }), /retired/);
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

// P1：组件必须走统一出口，否则连到独立 Service 时会缺 Authorization。
test("no UI module calls fetch directly on an api url or opens a raw EventSource", async () => {
  const { readdir } = await import("node:fs/promises");
  const offenders = [];
  for (const directory of ["components", "hooks"]) {
    for (const name of await readdir(new URL(`../../${directory}/`, import.meta.url))) {
      if (!/\.(ts|tsx)$/.test(name) || name.includes(".test.")) continue;
      const source = await readFile(new URL(`../../${directory}/${name}`, import.meta.url), "utf8");
      if (/[^i]fetch\(\s*apiUrl\(/.test(source)) offenders.push(`${directory}/${name}: fetch(apiUrl(...))`);
      if (source.includes("new EventSource(")) offenders.push(`${directory}/${name}: new EventSource(...)`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(await readFile(new URL("../api-fetch.ts", import.meta.url), "utf8"), /export async function apiFetch/);
  assert.match(await readFile(new URL("../event-stream.ts", import.meta.url), "utf8"), /export function createEventStream/);
});

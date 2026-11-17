import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

// B1 静态入口的结构约束：Desktop 用 Vite 产静态资产，Web 仍走 Next。
const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("a static Vite entry exists and mounts the shared AppShell", async () => {
  for (const file of ["desktop/index.html", "desktop/main.tsx", "vite.config.ts"]) {
    assert.ok(existsSync(new URL(file, root)), `${file} must exist`);
  }
  const main = await read("desktop/main.tsx");
  assert.match(main, /@\/components\/AppShell/);
  assert.match(main, /createRoot\(/);
  // 静态入口不得自己实现一套 UI。
  assert.doesNotMatch(main, /function AppShell|class AppShell/);
});

test("host-specific navigation and lazy loading go through one seam", async () => {
  const nextNav = await read("lib/navigation.ts");
  assert.match(nextNav, /from "next\/navigation"/);

  const staticNav = await read("lib/navigation.static.ts");
  assert.match(staticNav, /history\.pushState/);
  assert.match(staticNav, /popstate/);
  assert.doesNotMatch(staticNav, /next\//);

  const vite = await read("vite.config.ts");
  assert.match(vite, /@\\\/lib\\\/navigation\$/);

  // 组件只依赖接缝，不直接依赖 Next。
  for (const file of ["components/AppShell.tsx", "components/MarkdownEditor.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /from "next\//, `${file} must not import next/*`);
  }
});

test("an unconfigured UI shows a visible error without mounting request-producing components", async () => {
  const shell = await read("components/AppShell.tsx");
  const gate = shell.slice(shell.indexOf("export function AppShell()"), shell.indexOf("function ConfiguredAppShell()"));
  assert.match(gate, /isApiBaseConfigured\(\)/);
  assert.match(gate, /if \(!configured\)/);
  assert.match(gate, /role="alert"/);
  assert.match(gate, /Agent Service is not configured/);
  assert.match(gate, /dismissStartupSplash\(\)/);
  assert.ok(gate.indexOf('role="alert"') < gate.indexOf("<ConfiguredAppShell"));
  assert.doesNotMatch(gate, /useCodexUsage|useAgentSession|apiFetch\(/);
});

test("the static build excludes server and agent runtime code", async () => {
  const vite = await read("vite.config.ts");
  assert.match(vite, /outDir:.*desktop-ui/);
  // UI 包不得包含 Pi SDK / Node 内建模块。
  const main = await read("desktop/main.tsx");
  for (const forbidden of ["@earendil-works", "node:", "@/lib/rpc-manager"]) {
    assert.equal(main.includes(forbidden), false, `static entry must not import ${forbidden}`);
  }
});

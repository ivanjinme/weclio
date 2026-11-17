import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceFiles = (directory) => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? sourceFiles(file) : /\.(?:[cm]?[jt]sx?)$/.test(file) ? [file] : [];
}) : [];
function imports(file) {
  // 编译后解析可准确忽略 import type 和混合导入中的类型，避免误报 SDK 类型。
  const javascript = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const source = ts.createSourceFile(file + ".js", javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const values = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      values.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
      assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `untraceable runtime import in ${relative(root, file)}`);
      values.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}
function resolveLocal(from, specifier) {
  const base = specifier.startsWith("@/") ? resolve(root, specifier.slice(2))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  const file = [base, ...[".ts", ".tsx", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => base + suffix)]
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!file || !/\.[cm]?[jt]sx?$/.test(file)) return null;
  return file;
}

test("Next app contains no API business handler (including proxy or tombstone adapters)", () => {
  assert.deepEqual(sourceFiles(join(root, "app", "api")), []);
  assert.deepEqual(sourceFiles(join(root, "app")).filter((file) => /(?:^|[/\\])route\.[cm]?[jt]sx?$/.test(file)), []);
});

test("the complete Next/UI value-import graph cannot reach Pi or server business services", () => {
  const pending = sourceFiles(join(root, "app"));
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const local = relative(root, file).replaceAll("\\", "/");
    assert.doesNotMatch(local, /^lib\/(?:rpc-manager|model-runtime|session-reader|project-trust|agent\/(?:service\/|.*-service\.|admission\.|oauth-login-service\.|session-events\.))/,
      `UI must not reach server module ${local}`);
    for (const specifier of imports(file)) {
      assert.doesNotMatch(specifier, /^(?:node:|@earendil-works\/pi-|@mariozechner\/pi-)/,
        `${local} imports server runtime ${specifier}`);
      const target = resolveLocal(file, specifier);
      if (target) pending.push(target);
    }
  }
  assert.ok(visited.size > 20, "the boundary check must trace transitive UI dependencies");
});

test("Next instrumentation has no runtime admission or busy-task gate", () => {
  const file = join(root, "instrumentation.ts");
  if (!existsSync(file)) return;
  assert.doesNotMatch(readFileSync(file, "utf8"), /rpc-manager|agent\/(?:admission|service)|hasBusyDesktopTasks|registerDesktopRuntimeGate|PI_CODING_AGENT_DIR/);
  for (const specifier of imports(file)) {
    assert.doesNotMatch(specifier, /rpc-manager|desktop-update|agent\//);
  }
});

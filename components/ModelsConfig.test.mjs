import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const response = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const invalidJson = (ok, status) => ({ ok, status, json: async () => { throw new SyntaxError("Invalid JSON"); } });
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props.children);
  return typeof tree === "string" ? tree : "";
}

// 执行完整组件的加载、重试和保存流程，只替换 hooks 与外部边界。
function harness(load) {
  const slots = [];
  const effects = [];
  const requests = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  const changed = (previous, deps) => !previous || deps.some((value, index) => !Object.is(value, previous[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (update) => {
        slots[index] = typeof update === "function" ? update(slots[index]) : update;
        dirty = true;
      }];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) {
        slots[index] = { deps };
        effects.push(callback);
      }
    },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    react: hooks,
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "@/hooks/useIsMobile": { useIsMobile: () => false },
    "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
    "@/lib/models-config-import": { findProviderMissingModelBaseUrl: () => null },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, Error,
    require(name) {
      if (name.startsWith("@lobehub/icons/")) return { default: "Icon" };
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === "/api/models-config") {
        return options?.method === "PUT" ? response({ success: true }) : load();
      }
      assert.ok(url === "/api/auth/providers" || url === "/api/auth/all-providers");
      return response({ providers: [] });
    },
    setTimeout() {},
  });
  function flush() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 20, "component entered a render loop");
      dirty = false;
      cursor = 0;
      tree = exports.ModelsConfig();
      for (const effect of effects.splice(0)) effect();
    }
  }
  flush();
  return {
    requests,
    find: (predicate) => nodes(tree).find(predicate),
    button: (key) => nodes(tree).find((node) => node.type === "button" && text(node).includes(key)),
    get text() { return text(tree); },
    click(node) { assert.ok(node, "click target exists"); node.props.onClick(); flush(); },
    async settle() {
      for (let count = 0; count < 4; count++) {
        await new Promise((resolve) => setImmediate(resolve));
        flush();
      }
    },
  };
}

function assertLocked(view) {
  assert.equal(view.button("i18n.save"), undefined);
  assert.equal(view.button("i18n.addProvider"), undefined);
  assert.equal(view.find((node) => typeof node.type === "function"), undefined);
  assert.equal(view.requests.some(({ options }) => options?.method === "PUT"), false);
}

for (const [name, load, message] of [
  ["HTTP error with JSON body", () => response({ error: "models.json cannot be read" }, false, 500), "models.json cannot be read"],
  ["HTTP error without JSON body", () => invalidJson(false, 503), "HTTP 503"],
  ["network error", () => { throw new Error("Network unavailable"); }, "Network unavailable"],
  ["invalid successful JSON", () => invalidJson(true, 200), "Invalid JSON"],
]) {
  test(`${name} blocks editing and saving and offers reload`, async () => {
    const view = harness(load);
    assertLocked(view);
    assert.ok(view.text.includes("i18n.loading"));
    await view.settle();
    assertLocked(view);
    const alert = view.find((node) => node.props.role === "alert");
    assert.ok(alert);
    assert.ok(text(alert).includes(message));
    assert.ok(text(alert).includes("i18n.modelsConfigLoadFailed"));
    assert.ok(view.button("i18n.reloadModelsConfig"));
  });
}

test("failed reload remains locked; successful reload restores the actual file before saving", async () => {
  let resolveLoad;
  const view = harness(() => new Promise((resolve) => { resolveLoad = resolve; }));
  const original = { providers: { restored: { baseUrl: "https://example.com", models: [{ id: "original-model" }] } }, customField: "preserve" };
  for (let attempt = 0; attempt < 2; attempt++) {
    resolveLoad(response({ error: "Unreadable file" }, false, 500));
    await view.settle();
    assertLocked(view);
    view.click(view.button("i18n.reloadModelsConfig"));
    assertLocked(view);
    assert.ok(view.text.includes("i18n.loading"));
    assert.equal(view.button("i18n.reloadModelsConfig"), undefined);
  }
  resolveLoad(response(original));
  await view.settle();
  assert.equal(view.find((node) => node.props.role === "alert"), undefined);
  assert.ok(view.text.includes("restored"));
  assert.ok(view.text.includes("original-model"));
  assert.ok(view.button("i18n.addProvider"));
  const detail = view.find((node) => node.type?.name === "ProviderDetail");
  assert.equal(detail.props.name, "restored");
  assert.equal(detail.props.provider.models[0].id, "original-model");
  view.click(view.button("i18n.save"));
  await view.settle();
  const writes = view.requests.filter(({ options }) => options?.method === "PUT");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), original);
});

test("a successfully loaded empty configuration remains editable", async () => {
  const view = harness(() => response({}));
  await view.settle();
  assert.ok(view.button("i18n.addProvider"));
  view.click(view.button("i18n.save"));
  await view.settle();
  const write = view.requests.find(({ options }) => options?.method === "PUT");
  assert.deepEqual(JSON.parse(write.options.body), { providers: {} });
});

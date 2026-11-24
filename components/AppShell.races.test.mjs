import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const [filePaths, artifactTabs, projectFolders] = await Promise.all([
  jiti.import("../lib/file-paths.ts"), jiti.import("../lib/artifact-tabs.ts"), jiti.import("../lib/project-folders.ts"),
]);
const { PROJECT_FOLDER_CONFIRMED_EVENT } = projectFolders;
const compiled = Object.fromEntries(await Promise.all(["AppShell", "FileExplorer"].map(async (name) => {
  const source = await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8");
  return [name, ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText];
})));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props.children)];
}

// 执行组件真实回调与 effect，只替换 React 提交、DOM 与网络边界。
function mount(name, { exportsName = name, props = {}, mocks = {}, apiFetch, XMLHttpRequest } = {}) {
  const slots = [];
  const layout = [];
  const passive = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  function cached(value, deps, queue) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      const slot = slots[index] = { deps };
      if (queue) queue.push(() => { previous?.cleanup?.(); slot.cleanup = value(); });
      else slot.value = value();
    }
    return slots[index].value;
  }
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (update) => {
        const value = typeof update === "function" ? update(slots[index]) : update;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    useReducer(reduce, initial) {
      const [state, setState] = react.useState(initial);
      return [state, (action) => setState((value) => reduce(value, action))];
    },
    useRef: (initial) => slots[cursor++] ??= { current: initial },
    useMemo: (factory, deps) => cached(factory, deps),
    useCallback: (fn, deps) => cached(() => fn, deps),
    useLayoutEffect: (fn, deps) => cached(fn, deps, layout),
    useEffect: (fn, deps) => cached(fn, deps, passive),
    useImperativeHandle() {},
    forwardRef: (render) => render,
  };
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const modules = {
    react, "react/jsx-runtime": { jsx: element, jsxs: element },
    "@/lib/api-base": { apiUrl: (path) => path }, "@/lib/api-fetch": { apiFetch },
    "@/lib/file-paths": filePaths, "@/lib/agent-credential": { agentAuthHeaders: () => new Headers() },
    "@/hooks/useI18n": { useI18n: () => ({ locale: "en", t: (key) => key }) },
    ...mocks,
  };
  const window = Object.assign(new EventTarget(), {
    innerWidth: 1200, localStorage: { getItem() { return null; }, setItem() {} }, requestAnimationFrame() {}, cancelAnimationFrame() {},
  });
  const exports = {};
  const expose = name === "AppShell" ? "\nexports.ConfiguredAppShell = ConfiguredAppShell;" : "";
  runInNewContext(compiled[name] + expose, {
    exports, require: (id) => modules[id] ?? (id.startsWith("./") ? { [id.slice(2)]: id.slice(2) } : {}),
    AbortController, DOMException, FormData, XMLHttpRequest, URLSearchParams, console,
    MutationObserver: class { observe() {} disconnect() {} },
    window,
    document: { documentElement: { style: { setProperty() {} } }, head: {} },
  });
  function flush() {
    for (let count = 0; dirty; count++) {
      assert.ok(count < 20, "component entered a render loop");
      cursor = 0;
      dirty = false;
      tree = exports[exportsName](props);
      for (const effect of layout.splice(0)) effect();
      for (const effect of passive.splice(0)) effect();
    }
  }
  flush();
  return {
    flush, window,
    find: (test) => nodes(tree).find(test),
    update(values) { Object.assign(props, values); dirty = true; flush(); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); flush(); },
  };
}

function shell(apiFetch) {
  const urls = [];
  const router = { replace: (url) => urls.push(url) };
  const app = mount("AppShell", { exportsName: "ConfiguredAppShell", apiFetch, mocks: {
    "@/lib/navigation": { useRouter: () => router, useSearchParams: () => new URLSearchParams() },
    "@/lib/initial-navigation": { getInitialNavigation: () => ({ requestedCwd: null, sessionId: null }) },
    "@/hooks/useKeyboardShortcuts": { useGlobalKeyboardShortcuts() {} },
    "@/hooks/useFileDraft": { createFileDraftCoordinator() {} },
    "@/hooks/useIsMobile": { useIsMobile: () => false },
    "@/hooks/useAudio": { useAudio: () => ({}) },
    "@/hooks/useCodexUsage": { useCodexUsage() {} },
    "@/lib/window-controls-overlay": { bindWindowControlsOverlay() {} },
    "@/lib/artifact-tabs": artifactTabs,
    "@/lib/project-folders": projectFolders,
  } });
  return {
    ...app, urls,
    chat: () => app.find((node) => node.type === "ChatWindow"),
    select(id, cwd) {
      const { onSelectSession, onCwdChange } = app.find((node) => node.type === "SessionSidebar").props;
      onSelectSession({ id, cwd });
      onCwdChange(cwd);
      app.flush();
    },
  };
}

for (const lateStage of ["preflight", "upload"]) {
  test(`Explorer ignores a ${lateStage} conflict delivered after switching projects`, async () => {
    const deferredCheck = deferred();
    const uploads = [];
    class FakeXHR {
      upload = {};
      open(_method, url) { this.url = url; }
      setRequestHeader() {}
      send() { uploads.push(this); }
    }
    const explorer = mount("FileExplorer", {
      props: { cwd: "/a", changesCollapsed: true }, XMLHttpRequest: FakeXHR,
      apiFetch: async (url) => url.endsWith("type=upload-check")
        ? (lateStage === "preflight" ? deferredCheck.promise : Response.json({}))
        : Response.json({ entries: [], isGitRepository: false }),
    });
    const conflict = { conflicts: ["same.txt"] };
    explorer.find((node) => node.type === "input").props.onChange({ target: { files: [new File(["a"], "same.txt")] } });
    await explorer.settle();
    assert.equal(uploads.length, lateStage === "preflight" ? 0 : 1);
    explorer.update({ cwd: "/b" });
    if (lateStage === "preflight") deferredCheck.resolve(Response.json(conflict));
    else {
      uploads[0].status = 409;
      uploads[0].responseText = JSON.stringify(conflict);
      uploads[0].onload();
    }
    await explorer.settle();
    assert.equal(explorer.find((node) => node.type === "button" && node.props.children === "files.replace"), undefined);
    assert.ok(uploads.every(({ url }) => url.startsWith("/files/a?")));
  });
}

test("Explorer refreshes the current tree when an earlier visit's upload succeeds", async () => {
  const lists = [];
  const uploads = [];
  class FakeXHR {
    upload = {};
    setRequestHeader() {}
    open() {}
    send() { uploads.push(this); }
  }
  const explorer = mount("FileExplorer", {
    props: { cwd: "/a", changesCollapsed: true }, XMLHttpRequest: FakeXHR,
    apiFetch: async (url) => {
      if (url.endsWith("type=list")) lists.push(url);
      return Response.json({ entries: [], isGitRepository: false });
    },
  });
  explorer.find((node) => node.type === "input").props.onChange({ target: { files: [new File(["a"], "new.txt")] } });
  await explorer.settle();
  assert.equal(uploads.length, 1);
  const [upload] = uploads;
  explorer.update({ cwd: "/b" });
  await explorer.settle();
  explorer.update({ cwd: "/a" });
  await explorer.settle();
  assert.deepEqual(lists, ["/files/a?type=list", "/files/b?type=list", "/files/a?type=list"]);
  upload.status = 200;
  upload.responseText = JSON.stringify({ uploaded: ["new.txt"] });
  upload.onload();
  await explorer.settle();
  assert.deepEqual(lists.slice(3), ["/files/a?type=list"]);
  assert.equal(explorer.find((node) => node.props["aria-label"] === "1 uploaded"), undefined);
});

for (const callback of ["onSessionCreated", "onSessionForked"]) {
  test(`AppShell ignores ${callback} from a previous chat`, async () => {
    const app = shell(async () => Response.json({}));
    app.select("a", "/a");
    const sidebar = app.find((node) => node.type === "SessionSidebar");
    if (callback === "onSessionCreated") {
      sidebar.props.onNewSession("draft-a", "/a");
      app.flush();
    }
    const late = app.chat().props[callback];
    app.select("b", "/b");
    const before = app.urls.length;
    late(callback === "onSessionCreated" ? { id: "late-a", cwd: "/a" } : "late-a");
    app.flush();
    await app.settle();
    assert.equal(app.chat().props.session.id, "b");
    assert.equal(app.chat().props.session.cwd, "/b");
    assert.equal(app.urls.length, before);
  });
}

test("confirming the current project folder refreshes trust without resetting the chat or dialog", async () => {
  const refresh = deferred();
  const requests = [];
  const app = shell(async (url, { signal }) => {
    assert.equal(url, "/project-trust?cwd=%2Fa");
    requests.push(signal);
    return requests.length === 1 ? Response.json({ requiresTrust: true, trusted: false }) : refresh.promise;
  });
  app.select("a", "/a");
  await app.settle();
  const chat = app.chat();
  chat.props.onOpenProjectTrust();
  app.flush();
  const dialog = () => app.find((node) => node.type === "ProjectTrustDialog");
  const confirmFolder = (cwd) => app.window.dispatchEvent(new CustomEvent(PROJECT_FOLDER_CONFIRMED_EVENT, { detail: cwd }));

  confirmFolder("/b");
  await app.settle();
  assert.equal(requests.length, 1);
  confirmFolder("/a");
  await app.settle();
  assert.equal(requests.length, 2);
  assert.ok(dialog());
  assert.equal(typeof app.chat().props.onOpenProjectTrust, "function", "the current status remains visible while refreshing");

  refresh.resolve(Response.json({ requiresTrust: true, trusted: true }));
  await app.settle();
  assert.equal(app.chat().props.onOpenProjectTrust, undefined);
  assert.ok(dialog());
  assert.equal(app.chat().key, chat.key);
  for (const prop of ["session", "newSessionCwd", "modelsRefreshKey", "sessionReload"]) {
    assert.equal(app.chat().props[prop], chat.props[prop], prop);
  }
});

test("a folder confirmation supersedes the current project's pending trust GET", async () => {
  const stale = deferred();
  const requests = [];
  const app = shell(async (_url, { signal }) => {
    requests.push(signal);
    return requests.length === 1 ? stale.promise : Response.json({ requiresTrust: true, trusted: true });
  });
  app.select("a", "/a");
  app.window.dispatchEvent(new CustomEvent(PROJECT_FOLDER_CONFIRMED_EVENT, { detail: "/a" }));
  await app.settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].aborted, true);
  stale.resolve(Response.json({ requiresTrust: true, trusted: false }));
  await app.settle();
  assert.equal(app.chat().props.onOpenProjectTrust, undefined);
});

test("AppShell ignores a trust POST that completes after switching projects", async () => {
  const trustA = deferred();
  const trustB = deferred();
  const app = shell(async (url, options) => {
    if (options?.method === "POST") {
      const { cwd } = JSON.parse(options.body);
      assert.match(cwd, /^\/[ab]$/);
      return cwd === "/a" ? trustA.promise : trustB.promise;
    }
    assert.match(url, /^\/project-trust\?cwd=%2F[ab]$/);
    return Response.json({ requiresTrust: true, trusted: false });
  });
  const openProjectTrust = () => app.chat().props.onOpenProjectTrust;
  const trustDialog = () => app.find((node) => node.type === "ProjectTrustDialog");
  const confirmTrust = () => {
    assert.equal(app.find((node) => node.props["aria-label"] === "trust.resourcesNotLoaded"), undefined);
    openProjectTrust()();
    app.flush();
    assert.equal(trustDialog().props.busy, false);
    trustDialog().props.onConfirm();
    app.flush();
  };
  app.select("a", "/a");
  await app.settle();
  confirmTrust();
  app.select("b", "/b");
  await app.settle();
  const chatKey = app.chat().key;
  confirmTrust();
  trustA.resolve(Response.json({ requiresTrust: true, trusted: true }));
  await app.settle();
  assert.equal(typeof openProjectTrust(), "function", "B is still untrusted");
  assert.equal(app.chat().key, chatKey, "B's chat did not remount");
  assert.equal(trustDialog().props.busy, true, "A cannot clear B's pending state");
  trustB.resolve(Response.json({ requiresTrust: true, trusted: true }));
  await app.settle();
  assert.equal(openProjectTrust(), undefined);
  assert.equal(trustDialog(), undefined);
  assert.notEqual(app.chat().key, chatKey, "B's own successful request remounts its chat");
});

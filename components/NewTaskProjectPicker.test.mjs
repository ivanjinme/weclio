import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const folders = await jiti.import("../lib/project-folders.ts");
async function compileComponent(name) {
  const source = await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const [compiled, compiledFolderPicker] = await Promise.all([
  compileComponent("NewTaskProjectPicker"), compileComponent("ProjectFolderPicker"),
]);
const DEFAULT = "D:/Configured/Task Home/";
const messages = {
  "chat.chooseProject": "Choose project",
  "chat.noProjectMode": "No project mode",
  "chat.newProject": "New project",
};
const response = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props.children)];
}
const text = (tree) => {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props.children);
  return typeof tree === "string" ? tree : "";
};
const hasCheck = (node) => nodes(node).some((child) => child.type === "polyline");

// 保留完整组件与 hooks 生命周期，只替换浏览器边界。
function pickerHarness({
  selectedCwd = null, localRoots = [], sessions = [],
  fetchDefault = async () => response({ cwd: DEFAULT }),
  fetchProject,
} = {}) {
  const parentSlots = [];
  let folderSlots = null;
  let slots = parentSlots;
  const effects = [];
  const requests = [];
  const actions = [];
  const window = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  window.addEventListener(folders.PROJECT_FOLDER_CONFIRMED_EVENT, (event) => actions.push(["confirmed", event.detail]));
  let cursor = 0;
  let dirty = true;
  let tree;
  let unmounted = false;
  let lateStateUpdates = 0;
  const props = {
    resetKey: "initial", selectedCwd,
    onSelect: (cwd) => actions.push(["select", cwd]),
    onClear: () => actions.push(["clear"]),
    onFocusComposer: () => actions.push(["focus"]),
  };
  const changed = (previous, deps) => !previous || !deps || deps.some((value, index) => !Object.is(value, previous[index]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
    return slots[index].value;
  };
  function effect(callback, deps) {
    const owner = slots;
    const index = cursor++;
    const previous = owner[index];
    if (changed(previous?.deps, deps)) {
      owner[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => {
        owner[index].cleanup?.();
        owner[index].cleanup = callback();
      });
    }
  }
  const hooks = {
    useState(initial) {
      const owner = slots;
      const index = cursor++;
      if (!(index in owner)) owner[index] = typeof initial === "function" ? initial() : initial;
      return [owner[index], (update) => {
        if (unmounted || (owner !== parentSlots && owner !== folderSlots)) lateStateUpdates++;
        const value = typeof update === "function" ? update(owner[index]) : update;
        if (!Object.is(value, owner[index])) { owner[index] = value; dirty = true; }
      }];
    },
    useRef: (initial) => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const domNode = {
    getBoundingClientRect: () => ({ left: 100, top: 400 }),
    focus() {}, contains: () => false,
  };
  const modules = {
    "@/lib/api-base": { apiUrl: (path) => `/api${path}` },
    "@/lib/api-fetch": { apiFetch: (url, init) => sandbox.fetch(url, init) },
    "@/lib/event-stream": {
      EVENT_STREAM_CONNECTING: 0,
      EVENT_STREAM_OPEN: 1,
      EVENT_STREAM_CLOSED: 2,
      createEventStream: () => ({ close() {}, addEventListener() {}, removeEventListener() {}, readyState: 2, onmessage: null, onerror: null, onopen: null }),
    },
    react: hooks,
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "react-dom": { createPortal: (child) => child },
    "@/lib/project-folders": {
      ...folders,
      loadProjectFolders: () => localRoots,
      loadHiddenProjectFolders: () => [],
      rememberProjectFolder: (cwd) => actions.push(["remember", cwd]),
    },
    "@/hooks/useI18n": { useI18n: () => ({ t: (key) => messages[key] ?? key }) },
    "./ProjectFolderPicker": { ProjectFolderPicker: "ProjectFolderPicker" },
    "./DirectoryPicker": { DirectoryPicker: "DirectoryPicker" },
    "./ProjectTrustDialog": { ProjectTrustDialog: "ProjectTrustDialog" },
  };
  const exports = {};
  const sandbox = {
    exports, require: (name) => { assert.ok(name in modules, `Unexpected import: ${name}`); return modules[name]; },
    AbortController, CustomEvent,
    fetch: (url, options) => {
      requests.push({ url, options });
      if (url === "/api/cwd/default") return fetchDefault(options);
      if (url === "/api/sessions") return Promise.resolve(response({ sessions }));
      assert.ok(fetchProject, `Unexpected project request: ${url}`);
      return fetchProject(url, options);
    },
    window,
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  const folderExports = {};
  runInNewContext(compiledFolderPicker, { ...sandbox, exports: folderExports });
  runInNewContext(compiled, sandbox);
  function cleanUp(owner) {
    for (const slot of owner ?? []) slot?.cleanup?.();
  }
  function flush() {
    for (let count = 0; dirty && !unmounted; count++) {
      assert.ok(count < 20, "component entered a render loop");
      dirty = false;
      cursor = 0;
      slots = parentSlots;
      tree = exports.NewTaskProjectPicker(props);
      const folder = nodes(tree).find((node) => node.type === "ProjectFolderPicker");
      if (folder) {
        slots = folderSlots ??= [];
        cursor = 0;
        folder.props.children = folderExports.ProjectFolderPicker(folder.props);
      } else if (folderSlots) {
        cleanUp(folderSlots);
        folderSlots = null;
      }
      for (const node of nodes(tree)) if (node.props.ref) node.props.ref.current = domNode;
      for (const effect of effects.splice(0)) effect();
    }
  }
  flush();
  const harness = {
    get tree() { return tree; }, requests, actions, flush,
    get lateStateUpdates() { return lateStateUpdates; },
    find(predicate) { return nodes(tree).find(predicate); },
    trigger() { return harness.find((node) => node.props.id === "new-task-project-trigger"); },
    rows() { return nodes(tree).filter((node) => node.type === "button" && node.props.className?.startsWith("project-popover-row")); },
    noProject() { return harness.find((node) => node.type === "button" && text(node).includes("No project mode")); },
    click(node) { assert.ok(node, "click target exists"); node.props.onClick(); flush(); },
    open() { harness.click(harness.trigger()); },
    update(values) { Object.assign(props, values); dirty = true; flush(); },
    async settle() {
      for (let count = 0; count < 4; count++) {
        await new Promise((resolve) => setImmediate(resolve));
        flush();
      }
    },
    unmount() {
      unmounted = true;
      cleanUp(folderSlots);
      cleanUp(parentSlots);
    },
  };
  return harness;
}

function assertNoProject(harness) {
  assert.equal(text(harness.trigger()), "Choose project");
  assert.equal(harness.find((node) => node.props.className === "new-task-project-clear"), undefined);
  assert.equal(harness.noProject().props["aria-current"], true);
  assert.equal(hasCheck(harness.noProject()), true);
}

test("GET resolves the configured default identity, excluding normalized local and session aliases only", async () => {
  const otherDefault = "D:/Projects/default-workspace";
  const harness = pickerHarness({
    localRoots: ["d:\\CONFIGURED\\TASK HOME\\", otherDefault, "D:/LocalOnly"],
    sessions: [
      { cwd: "D:/CONFIGURED/Task Home///", modified: "2026-01-03" },
      { cwd: "D:/SessionOnly", modified: "2026-01-02" },
    ],
  });
  await harness.settle();
  assert.equal(harness.requests[0].url, "/api/cwd/default");
  assert.equal(harness.requests[0].options.method ?? "GET", "GET");
  harness.open();
  await harness.settle();
  const paths = harness.rows().map((row) => nodes(row).find((node) => node.props.className === "project-popover-path").props.children);
  assert.deepEqual(paths.sort(), [otherDefault, "D:/LocalOnly", "D:/SessionOnly"].sort());
  assertNoProject(harness);
  harness.unmount();
});

test("null and normalized default selections render no-project mode; clicking clears, focuses and closes", async () => {
  for (const selectedCwd of [null, DEFAULT, "d:\\CONFIGURED\\TASK HOME\\", "D:/configured/task home///"]) {
    const harness = pickerHarness({ selectedCwd });
    await harness.settle();
    harness.open();
    await harness.settle();
    assertNoProject(harness);
    harness.click(harness.noProject());
    assert.deepEqual(harness.actions, [["clear"], ["focus"]]);
    assert.equal(harness.trigger().props["aria-expanded"], false);
    assert.equal(harness.noProject(), undefined);
    harness.unmount();
  }
});

test("real projects display a label and clear control, and selection calls back with the exact root", async () => {
  const root = "D:/Projects/Research";
  const harness = pickerHarness({ selectedCwd: "d:\\projects\\Research\\", localRoots: [root, "D:/Next"] });
  await harness.settle();
  assert.equal(text(harness.trigger()), "Research");
  assert.ok(harness.find((node) => node.props.className === "new-task-project-clear"));
  harness.open();
  await harness.settle();
  assert.equal(harness.noProject().props["aria-current"], undefined);
  assert.equal(hasCheck(harness.noProject()), false);
  const selected = harness.rows().find((row) => row.props["aria-current"]);
  assert.ok(text(selected).includes(root));
  assert.equal(hasCheck(selected), true);
  harness.click(harness.rows().find((row) => text(row).includes("D:/Next")));
  assert.deepEqual(harness.actions, [["select", "D:/Next"], ["focus"]]);
  assert.equal(harness.trigger().props["aria-expanded"], false);
  harness.click(harness.find((node) => node.props.className === "new-task-project-clear"));
  assert.deepEqual(harness.actions.slice(2), [["clear"], ["focus"]]);
  harness.unmount();
});

const trustDialog = (harness) => harness.find((node) => node.type === "ProjectTrustDialog");
const selectionRequests = (harness) => harness.requests.filter(({ url }) => !["/api/sessions", "/api/cwd/default"].includes(url));

function pickFolder(harness, cwd) {
  harness.open();
  harness.click(harness.find((node) => node.type === "button" && text(node) === "New project"));
  harness.find((node) => node.type === "DirectoryPicker").props.onSelect(cwd);
  harness.flush();
  assert.equal(trustDialog(harness).props.cwd, cwd);
  assert.deepEqual(selectionRequests(harness), []);
  assert.deepEqual(harness.actions, []);
}

test("New project posts only the chosen folder on confirmation and selects it only after success", async () => {
  const cwd = "D:/Projects/Research";
  const pending = deferred();
  const harness = pickerHarness({ fetchProject: () => pending.promise });
  await harness.settle();
  pickFolder(harness, cwd);
  trustDialog(harness).props.onConfirm();
  trustDialog(harness).props.onConfirm();
  harness.flush();
  assert.equal(trustDialog(harness).props.busy, true);
  assert.deepEqual(selectionRequests(harness).map(({ url, options }) => [url, options.method, JSON.parse(options.body)]), [
    ["/api/projects/select", "POST", { cwd }],
  ]);
  assert.deepEqual(harness.actions, []);
  pending.resolve(response({ cwd }));
  await harness.settle();
  assert.equal(trustDialog(harness), undefined);
  assert.deepEqual(harness.actions, [["remember", cwd], ["select", cwd], ["focus"], ["confirmed", cwd]]);
  harness.unmount();
});

test("cancel leaves the current project unchanged without posting or remembering the folder", async () => {
  const harness = pickerHarness({ selectedCwd: "D:/Projects/Current" });
  await harness.settle();
  pickFolder(harness, "D:/Projects/Other");
  trustDialog(harness).props.onCancel();
  harness.flush();
  assert.equal(trustDialog(harness), undefined);
  assert.equal(text(harness.trigger()), "Current");
  assert.deepEqual(selectionRequests(harness), []);
  assert.deepEqual(harness.actions, []);
  harness.unmount();
});

test("a failed selection keeps the confirmation open and the current project unchanged", async () => {
  const harness = pickerHarness({
    selectedCwd: "D:/Projects/Current",
    fetchProject: async () => response({ error: { message: "Folder path changed" } }, false, 409),
  });
  await harness.settle();
  pickFolder(harness, "D:/Projects/Other");
  trustDialog(harness).props.onConfirm();
  await harness.settle();
  assert.equal(trustDialog(harness).props.busy, false);
  assert.equal(trustDialog(harness).props.error, "Folder path changed");
  assert.equal(text(harness.trigger()), "Current");
  assert.deepEqual(harness.actions, []);
  harness.unmount();
});

test("changing drafts discards a late selection response", async () => {
  const cwd = "D:/Projects/Research";
  const pending = deferred();
  const harness = pickerHarness({ fetchProject: () => pending.promise });
  await harness.settle();
  pickFolder(harness, cwd);
  trustDialog(harness).props.onConfirm();
  const { signal } = selectionRequests(harness)[0].options;
  harness.update({ resetKey: "next" });
  assert.equal(signal.aborted, true);
  pending.resolve(response({ cwd }));
  await harness.settle();
  assert.equal(trustDialog(harness), undefined);
  assert.deepEqual(harness.actions, []);
  assert.equal(harness.lateStateUpdates, 0);
  harness.unmount();
});

test("POSIX projects differing only in case from the default remain selectable", async () => {
  const root = "/home/user/Tasks";
  const defaultRoot = "/home/user/tasks";
  const harness = pickerHarness({
    selectedCwd: root, localRoots: [defaultRoot, root],
    fetchDefault: async () => response({ cwd: defaultRoot }),
  });
  await harness.settle();
  assert.equal(text(harness.trigger()), "Tasks");
  assert.ok(harness.find((node) => node.props.className === "new-task-project-clear"));
  harness.open();
  await harness.settle();
  assert.equal(harness.rows().length, 1);
  assert.ok(text(harness.rows()[0]).includes(root));
  assert.equal(harness.rows()[0].props["aria-current"], true);
  assert.equal(harness.noProject().props["aria-current"], undefined);
  harness.unmount();
});

test("pending default identity never leaks a selected path label or candidate list", async () => {
  const pending = deferred();
  const harness = pickerHarness({ selectedCwd: DEFAULT, localRoots: [DEFAULT, "D:/Real"], fetchDefault: () => pending.promise });
  assert.equal(text(harness.trigger()), "Choose project");
  assert.equal(harness.trigger().props.title, "chat.chooseProjectHint");
  assert.equal(harness.find((node) => node.props.className === "new-task-project-clear"), undefined);
  harness.open();
  await harness.settle();
  assert.deepEqual(harness.rows(), []);
  assert.ok(text(harness.tree).includes("sidebar.loading"));
  assert.ok(!text(harness.tree).includes(DEFAULT));
  pending.resolve(response({ cwd: DEFAULT }));
  await harness.settle();
  assertNoProject(harness);
  assert.equal(harness.rows().length, 1);
  assert.ok(text(harness.rows()[0]).includes("D:/Real"));
  harness.unmount();
});

test("default GET failures surface an alert rather than exposing unresolved project paths", async () => {
  for (const fetchDefault of [
    async () => response({ error: "Configured workspace unavailable" }, false, 503),
    async () => response({}, true, 200),
    async () => { throw new Error("Network unavailable"); },
  ]) {
    const harness = pickerHarness({ selectedCwd: DEFAULT, localRoots: [DEFAULT], fetchDefault });
    await harness.settle();
    harness.open();
    await harness.settle();
    const alert = harness.find((node) => node.props.role === "alert");
    assert.ok(alert);
    assert.match(text(alert), /Configured workspace unavailable|HTTP 200|Network unavailable/);
    assert.deepEqual(harness.rows(), []);
    assert.equal(text(harness.trigger()), "Choose project");
    harness.unmount();
  }
});

test("failed default lookup retries after reopening or changing drafts", async () => {
  for (const retry of ["reopen", "draft"]) {
    let available = false;
    const harness = pickerHarness({
      localRoots: [DEFAULT, "D:/Real"],
      fetchDefault: async () => available ? response({ cwd: DEFAULT }) : response({ error: "Offline" }, false, 503),
    });
    await harness.settle();
    harness.open();
    await harness.settle();
    assert.ok(harness.find((node) => node.props.role === "alert"));
    available = true;
    if (retry === "reopen") {
      harness.click(harness.trigger());
      harness.open();
    } else {
      harness.update({ resetKey: "next" });
      await harness.settle();
      harness.open();
    }
    await harness.settle();
    assert.equal(harness.find((node) => node.props.role === "alert"), undefined);
    assert.equal(harness.rows().length, 1);
    assert.ok(text(harness.rows()[0]).includes("D:/Real"));
    harness.unmount();
  }
});

test("unmount aborts default GET and ignores late success and failure without setting state", async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    const harness = pickerHarness({ fetchDefault: () => pending.promise });
    const signal = harness.requests[0].options.signal;
    assert.equal(signal.aborted, false);
    harness.unmount();
    assert.equal(signal.aborted, true);
    if (reject) pending.reject(new Error("Late failure"));
    else pending.resolve(response({ cwd: DEFAULT }));
    await harness.settle();
    assert.equal(harness.lateStateUpdates, 0);
  }
});

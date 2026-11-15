import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "weclio-workspace-service-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const sidebarPath = join(root, "sidebar.json");

const bareJiti = createJiti(import.meta.url);
const pins = await bareJiti.import("../sidebar-pins.ts");
const { AgentProtocolError } = await bareJiti.import("./protocol/validate.ts");
const { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } = await bareJiti.import("../file-access.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "../sidebar-pins": {
      readSidebarPins: () => pins.readSidebarPins(sidebarPath),
      setSidebarPin: (pin, pinned) => pins.setSidebarPin(pin, pinned, sidebarPath),
      rebindPinnedProject: (from, to) => pins.rebindPinnedProject(from, to, sidebarPath),
    },
  },
});
const service = await jiti.import("./workspace-service.ts");
const { invalidateSessionListCache } = await bareJiti.import("../session-reader.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function dir(name) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function runtime({ busy = false } = {}) {
  const calls = { destroy: 0 };
  return {
    calls,
    hasBusyForCwd: () => busy,
    hasBusyForCwds: () => busy,
    destroyForCwds: async () => { calls.destroy += 1; return 1; },
    runningIds: () => [],
  };
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgentProtocolError, `expected protocol error, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("ensuring the default workspace creates and authorizes it", async () => {
  const cwd = join(root, "default-workspace");
  assert.equal(service.ensureWorkspace(cwd), cwd);
  assert.equal(existsSync(cwd), true);
  assert.equal(isFilePathAllowed(join(cwd, "file.txt"), await getAllowedFileRoots()), true);
});

test("validate accepts existing directories and rejects missing or non-directories", async () => {
  const cwd = dir("chosen");
  assert.deepEqual(service.validateWorkspace(` ${cwd} `), { cwd });
  assert.equal(isFilePathAllowed(join(cwd, "x"), await getAllowedFileRoots()), true);

  await rejectsWithCode(Promise.resolve().then(() => service.validateWorkspace("   ")), "invalid_argument");
  await rejectsWithCode(
    Promise.resolve().then(() => service.validateWorkspace(join(root, "missing"))),
    "invalid_argument",
  );
  const file = join(root, "plain.txt");
  writeFileSync(file, "x");
  await rejectsWithCode(Promise.resolve().then(() => service.validateWorkspace(file)), "invalid_argument");
});

test("browse lists subdirectories and reports missing paths as not found", async () => {
  const parent = dir("browse-parent");
  const child = dir("browse-parent/child");
  writeFileSync(join(parent, "file.txt"), "x");

  const result = await service.browseWorkspace(parent);
  assert.equal(result.path.endsWith("browse-parent"), true);
  assert.equal(result.path === parent, true);
  assert.deepEqual(result.directories.map((entry) => entry.name), ["child"]);
  assert.equal(result.parentPath, join(root));

  await rejectsWithCode(service.browseWorkspace(join(root, "nope")), "not_found");
  await rejectsWithCode(service.browseWorkspace(join(child, "..", "file.txt")), "invalid_argument");
});

test("project trust requires an allowed root and a project that needs trust", async () => {
  const project = dir("trusted-project");
  await rejectsWithCode(service.readProjectTrust(project), "forbidden");

  allowFileRoot(project);
  assert.deepEqual(await service.readProjectTrust(project), { requiresTrust: false, trusted: true });
  await rejectsWithCode(service.grantProjectTrust(project, runtime()), "conflict");

  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "probe.js"), "export default () => {};\n");
  assert.deepEqual(await service.readProjectTrust(project), { requiresTrust: true, trusted: false });
});

test("granting trust refuses busy projects, then persists and releases the runtime", async () => {
  const project = dir("busy-project");
  allowFileRoot(project);
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "probe.js"), "export default () => {};\n");

  await rejectsWithCode(service.grantProjectTrust(project, runtime({ busy: true })), "conflict");
  assert.deepEqual(await service.readProjectTrust(project), { requiresTrust: true, trusted: false });

  const busyRuntime = runtime({ busy: true });
  const idleRuntime = runtime();
  assert.deepEqual(await service.grantProjectTrust(project, { ...busyRuntime, hasBusyForCwd: () => false }), {
    requiresTrust: true,
    trusted: true,
  });
  assert.equal(idleRuntime.calls.destroy, 0);
  assert.deepEqual(await service.readProjectTrust(project), { requiresTrust: true, trusted: true });
});

test("rebinding rewrites session cwd, moves the pin and updates allowed roots", async () => {
  const oldRoot = dir("rebind-old");
  const newRoot = dir("rebind-new");
  allowFileRoot(oldRoot);
  pins.setSidebarPin({ type: "project", id: oldRoot }, true, sidebarPath);

  const manager = SessionManager.create(oldRoot);
  manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
  invalidateSessionListCache();

  await rejectsWithCode(service.rebindProject({ oldRoot, newRoot }, runtime({ busy: true })), "conflict");

  const idle = runtime();
  const result = await service.rebindProject({ oldRoot, newRoot }, idle);
  assert.deepEqual(result, { ok: true, migratedSessions: 1, cwd: newRoot });
  assert.equal(idle.calls.destroy, 1);

  const header = JSON.parse(readFileSync(manager.getSessionFile(), "utf8").split("\n")[0]);
  assert.equal(header.cwd, newRoot);
  assert.deepEqual(service.listPins(), [{ type: "project", id: newRoot }]);
  const roots = await getAllowedFileRoots();
  assert.equal(isFilePathAllowed(join(newRoot, "x"), roots), true);
});

test("rebinding to the same root is a no-op", async () => {
  const cwd = dir("rebind-same");
  const runtimeStub = runtime();
  assert.deepEqual(await service.rebindProject({ oldRoot: cwd, newRoot: cwd }, runtimeStub), {
    ok: true,
    migratedSessions: 0,
    cwd,
  });
  assert.equal(runtimeStub.calls.destroy, 0);
});

test("rebind validates input before touching sessions", async () => {
  await rejectsWithCode(service.rebindProject({ oldRoot: "", newRoot: "x" }, runtime()), "invalid_argument");
  await rejectsWithCode(service.rebindProject({ oldRoot: root, newRoot: join(root, "missing") }, runtime()), "invalid_argument");
});

test("pins round-trip through the host-neutral service", () => {
  pins.setSidebarPin({ type: "session", id: "s1" }, true, sidebarPath);
  assert.ok(service.listPins().some((pin) => pin.type === "session" && pin.id === "s1"));
  assert.equal(service.setPinned("session", "s1", false).some((pin) => pin.id === "s1"), false);
  assert.throws(() => service.setPinned("session", "", true), (error) => {
    assert.ok(error instanceof AgentProtocolError);
    assert.equal(error.code, "invalid_argument");
    return true;
  });
});

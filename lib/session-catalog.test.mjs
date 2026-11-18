import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let files = [];
let discoveries = 0;
let titleReads = [];
let discovery = async () => files;
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "./session-summary": {
      discoverSessionFiles: async () => { discoveries++; return discovery(); },
      readSessionTitles: async (sessions) => {
        titleReads.push(...sessions.map((session) => session.id));
        return sessions.map((session) => ({ id: session.id, name: "title", firstMessage: "" }));
      },
    },
  },
});
const {
  listAllSessions, loadSessionTitles, resolveSessionPath, resolveSessionIdByPath,
  invalidateSessionListCache, invalidateSessionPathCache, subscribeSessionListChanges,
} = await jiti.import("./session-reader.ts");

function reset() {
  discoveries = 0;
  titleReads = [];
  files = [
    { path: "/sessions/new.jsonl", modified: "2026-02-01", header: { id: "new", cwd: "/main/nested", timestamp: "2026-01-01", parentSession: "/sessions/old.jsonl" } },
    { path: "/sessions/old.jsonl", modified: "2026-01-01", header: { id: "old", cwd: "/main", timestamp: "2026-01-01" } },
  ];
  discovery = async () => files;
  invalidateSessionListCache();
}

test("catalog returns metadata and lineage without reading any titles or transcripts", async () => {
  reset();
  const sessions = await listAllSessions();
  assert.equal(discoveries, 1);
  assert.deepEqual(titleReads, []);
  assert.equal(sessions[0].parentSessionId, "old");
  assert.equal(sessions[0].cwd, "/main/nested");
  assert.equal(sessions[0].titleLoaded, false);
  assert.equal(sessions[0].messageCount, undefined);
  assert.equal(await resolveSessionPath("new"), files[0].path.replaceAll("/", process.platform === "win32" ? "\\" : "/"));
  await listAllSessions();
  assert.equal(discoveries, 1);
});

test("catalog groups sessions by their own cwd without collapsing nested or sibling directories", async () => {
  reset();
  files.push(
    { path: "/sessions/same.jsonl", modified: "2026-02-02", header: { id: "same", cwd: "/main/nested", timestamp: "2026-01-01" } },
    { path: "/sessions/sibling.jsonl", modified: "2026-02-03", header: { id: "sibling", cwd: "/other", timestamp: "2026-01-01" } },
  );
  const sessions = await listAllSessions();
  const groups = new Map();
  for (const session of sessions) {
    const group = groups.get(session.cwd) ?? [];
    group.push(session.id);
    groups.set(session.cwd, group);
  }
  assert.deepEqual([...groups], [
    ["/main/nested", ["new", "same"]],
    ["/main", ["old"]],
    ["/other", ["sibling"]],
  ]);
  assert.equal(sessions[0].parentSessionId, "old");
  assert.deepEqual(titleReads, []);
});

test("only explicitly requested existing IDs load titles", async () => {
  reset();
  assert.deepEqual(await loadSessionTitles(["old", "old", "../../unrelated"]), [{ id: "old", name: "title", firstMessage: "" }]);
  assert.deepEqual(titleReads, ["old"]);
});

test("concurrent discoveries coalesce; invalidated work cannot repopulate cache", async () => {
  reset();
  const gate = Promise.withResolvers();
  discovery = () => gate.promise;
  const first = listAllSessions();
  const second = listAllSessions();
  assert.equal(discoveries, 1);
  invalidateSessionListCache();
  discovery = async () => [];
  await listAllSessions();
  gate.resolve(files);
  await Promise.all([first, second]);
  assert.deepEqual(await listAllSessions(), []);
  assert.equal(discoveries, 2);
});

test("cold ID and path lookups retry discovery after an unrelated invalidation", async () => {
  reset();
  const session = {
    path: "/sessions/present.jsonl", modified: "2026-02-04",
    header: { id: "present", cwd: "/main", timestamp: "2026-01-01" },
  };
  const gate = Promise.withResolvers();
  discovery = () => gate.promise;
  const byId = resolveSessionPath(session.header.id);
  const byPath = resolveSessionIdByPath(session.path);
  assert.equal(discoveries, 1);
  invalidateSessionListCache();
  discovery = async () => [session];
  gate.resolve([session]);

  const [path, id] = await Promise.all([byId, byPath]);
  assert.equal(path, session.path.replaceAll("/", process.platform === "win32" ? "\\" : "/"));
  assert.equal(id, session.header.id);
  assert.equal(discoveries, 2);
});

test("discovery finishing after deletion cannot restore either session path mapping", async () => {
  reset();
  const [deleted, retained] = files;
  await listAllSessions();
  assert.equal(await resolveSessionIdByPath(deleted.path), deleted.header.id);
  invalidateSessionListCache();

  const gate = Promise.withResolvers();
  discovery = () => gate.promise;
  const stale = listAllSessions();
  invalidateSessionPathCache(deleted.header.id);
  invalidateSessionListCache();
  discovery = async () => [retained];
  await listAllSessions();
  gate.resolve([deleted, retained]);
  await stale;

  assert.equal(await resolveSessionPath(deleted.header.id), null);
  assert.equal(await resolveSessionIdByPath(deleted.path), undefined);
  assert.equal(await resolveSessionIdByPath(retained.path), retained.header.id);
});

test("catalog invalidation notifies and unsubscribes sidebar listeners", () => {
  let updates = 0;
  const unsubscribe = subscribeSessionListChanges(() => updates++);
  invalidateSessionListCache();
  unsubscribe();
  invalidateSessionListCache();
  assert.equal(updates, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { createJiti } from "jiti";

// 与组件兼容性测试一致：保留稳定 setter、ref 和 effect 清理语义。
function createHooks() {
  const cells = [];
  let cursor = 0;
  let pendingEffects = [];
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const useState = (initial) => {
    const index = cursor++;
    if (!cells[index]) {
      const cell = { value: typeof initial === "function" ? initial() : initial };
      cell.set = (value) => { cell.value = typeof value === "function" ? value(cell.value) : value; };
      cells[index] = cell;
    }
    return [cells[index].value, cells[index].set];
  };
  const memoize = (fn, deps) => {
    const index = cursor++;
    if (!cells[index] || !sameDeps(cells[index].deps, deps)) cells[index] = { value: fn(), deps };
    return cells[index].value;
  };
  return {
    render(fn) { cursor = 0; return fn(); },
    flushEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) effect();
    },
    cleanup() {
      for (const cell of cells) { cell.cleanup?.(); cell.cleanup = undefined; }
    },
    react: {
      ...React, useState,
      useRef(initial) { return useState(() => ({ current: initial }))[0]; },
      useMemo: memoize,
      useCallback(fn, deps) { return memoize(() => fn, deps); },
      useEffect(fn, deps) {
        const index = cursor++;
        const previous = cells[index];
        if (!previous || !sameDeps(previous.deps, deps)) {
          const cell = { deps, cleanup: previous?.cleanup };
          cells[index] = cell;
          pendingEffects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
        }
      },
    },
  };
}

async function setup(t) {
  const hooks = createHooks();
  t.after(() => hooks.cleanup());
  const calls = [];
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/resource-client": {
        acquireResource(request, options) {
          return new Promise((resolve, reject) => calls.push({ request, options, resolve, reject }));
        },
      },
    },
  });
  const { useResourceUrl } = await jiti.import("./useResourceUrl.ts");
  return { hooks, calls, render: (request, options) => hooks.render(() => useResourceUrl(request, options)) };
}

function lease(url, expiresAt = 123) {
  return { url, transport: "blob", expiresAt, releases: 0, release() { this.releases++; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const initial = { filePath: "/workspace/one.png", kind: "preview", sessionId: "s1", revision: 1 };

test("replacement hides old URL immediately, aborts/releases its lease, and cleans up on unmount", async (t) => {
  const { hooks, calls, render } = await setup(t);
  assert.equal(render(initial).url, undefined);
  hooks.flushEffects();
  assert.deepEqual(calls[0].request, initial);
  const first = lease("blob:first");
  calls[0].resolve(first);
  await settle();
  assert.equal(render(initial).url, first.url);
  assert.equal(render(initial).expiresAt, first.expiresAt);
  assert.equal(calls.length, 1);
  const replacement = { ...initial, filePath: "/workspace/two.png" };
  assert.equal(render(replacement).url, undefined);
  hooks.flushEffects();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(first.releases, 1);
  const second = lease("blob:second");
  calls[1].resolve(second);
  await settle();
  assert.equal(render(replacement).url, second.url);
  hooks.cleanup();
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(second.releases, 1);
});

test("late result from replaced request is released without overwriting the current URL", async (t) => {
  const { hooks, calls, render } = await setup(t);
  render(initial); hooks.flushEffects();
  const replacement = { ...initial, filePath: "/workspace/two.png" };
  render(replacement); hooks.flushEffects();
  const current = lease("blob:current");
  calls[1].resolve(current);
  await settle();
  const stale = lease("blob:stale");
  calls[0].resolve(stale);
  await settle();
  assert.equal(stale.releases, 1);
  assert.equal(current.releases, 0);
  assert.equal(render(replacement).url, current.url);
  assert.equal(render(replacement).error, undefined);
});

test("late result after unmount is released and pending acquisition is aborted", async (t) => {
  const { hooks, calls, render } = await setup(t);
  render(initial); hooks.flushEffects();
  hooks.cleanup();
  assert.equal(calls[0].options.signal.aborted, true);
  const stale = lease("blob:unmounted");
  calls[0].resolve(stale);
  await settle();
  assert.equal(stale.releases, 1);
});

test("request keys include session, revision, kind and native but not object identity", async (t) => {
  const { hooks, calls, render } = await setup(t);
  let request = { ...initial };
  let options = { native: false };
  render(request, options); hooks.flushEffects();
  render({ ...request }, { ...options }); hooks.flushEffects();
  assert.equal(calls.length, 1);
  for (const change of [{ sessionId: "s2" }, { revision: 2 }, { kind: "read" }]) {
    request = { ...request, ...change };
    render(request, options); hooks.flushEffects();
  }
  options = { native: true };
  render(request, options); hooks.flushEffects();
  assert.equal(calls.length, 5);
  for (const call of calls.slice(0, -1)) assert.equal(call.options.signal.aborted, true);
  assert.equal(calls.at(-1).options.native, true);
});

test("optional source changes request identity and is omitted entirely when absent", async (t) => {
  const { hooks, calls, render } = await setup(t);
  const request = { ...initial, kind: "download" };
  render(request); hooks.flushEffects();
  assert.equal(Object.hasOwn(calls[0].request, "source"), false);
  const old = lease("blob:ordinary");
  calls[0].resolve(old); await settle();
  const bash = { ...request, source: "bash-output" };
  assert.equal(render(bash).url, undefined);
  hooks.flushEffects();
  assert.equal(old.releases, 1);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.deepEqual(calls[1].request, bash);
  render({ ...bash }); hooks.flushEffects();
  assert.equal(calls.length, 2);
  render(request); hooks.flushEffects();
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(Object.hasOwn(calls[2].request, "source"), false);
});

test("refresh releases the existing lease, clears URL and reacquires; stale errors stay hidden", async (t) => {
  const { hooks, calls, render } = await setup(t);
  const refresh = render(initial).refresh;
  hooks.flushEffects();
  const first = lease("blob:first");
  calls[0].resolve(first);
  await settle();
  assert.equal(render(initial).refresh, refresh);
  refresh();
  assert.equal(render(initial).url, undefined);
  hooks.flushEffects();
  assert.equal(first.releases, 1);
  assert.equal(calls.length, 2);
  const replacement = { ...initial, revision: 2 };
  render(replacement); hooks.flushEffects();
  calls[1].reject(new Error("stale error"));
  calls[2].reject(new Error("current error"));
  await settle();
  assert.equal(render(replacement).error, "current error");
  assert.equal(render(replacement).url, undefined);
});

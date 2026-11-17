import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { createJiti } from "jiti";

// 保留稳定 setter、ref 和 effect 清理；直接调用真实按钮的事件处理器。
function createHooks() {
  const cells = [];
  let cursor = 0;
  let effects = [];
  const useState = (initial) => {
    const index = cursor++;
    if (!cells[index]) {
      const cell = { value: typeof initial === "function" ? initial() : initial };
      cell.set = (value) => { cell.value = typeof value === "function" ? value(cell.value) : value; };
      cells[index] = cell;
    }
    return [cells[index].value, cells[index].set];
  };
  return {
    render(fn) { cursor = 0; return fn(); },
    flushEffects() { const pending = effects; effects = []; for (const effect of pending) effect(); },
    cleanup() { for (const cell of cells) { cell.cleanup?.(); cell.cleanup = undefined; } },
    react: {
      ...React, useState,
      useRef(initial) { return useState(() => ({ current: initial }))[0]; },
      useEffect(fn, deps) {
        const index = cursor++;
        const previous = cells[index];
        if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
          const cell = { deps, cleanup: previous?.cleanup };
          cells[index] = cell;
          effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
        }
      },
    },
  };
}

async function setup(t, initial = {}) {
  const hooks = createHooks();
  t.after(() => hooks.cleanup());
  const calls = [];
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    jsx: { runtime: "automatic" },
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/resource-client": {
        downloadResource(filePath, sessionId, options) {
          return new Promise((resolve, reject) => calls.push({ filePath, sessionId, options, resolve, reject }));
        },
      },
    },
  });
  const { ResourceDownloadButton } = await jiti.import("./ResourceDownloadButton.tsx");
  let props = { filePath: "/workspace/one.txt", sessionId: "s1", title: "Download", children: "Save", ...initial };
  const render = (changes = {}) => {
    props = { ...props, ...changes };
    return hooks.render(() => ResourceDownloadButton(props));
  };
  render(); hooks.flushEffects();
  return { hooks, calls, render };
}

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("real click disables while busy, guards duplicate clicks before render, then starts a fresh download", async (t) => {
  const { calls, render } = await setup(t, { source: "bash-output", className: "download" });
  let button = render();
  assert.equal(button.type, "button");
  assert.equal(button.props.type, "button");
  assert.equal(button.props.className, "download");
  assert.equal(button.props.children, "Save");
  button.props.onClick(event());
  button.props.onClick(event());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filePath, "/workspace/one.txt");
  assert.equal(calls[0].sessionId, "s1");
  assert.equal(calls[0].options.source, "bash-output");
  assert.equal(calls[0].options.signal.aborted, false);
  button = render();
  assert.equal(button.props.disabled, true);
  assert.equal(button.props["aria-busy"], true);
  button.props.onClick(event());
  assert.equal(calls.length, 1);
  calls[0].resolve(); await settle();
  button = render();
  assert.equal(button.props.disabled, false);
  assert.equal(button.props["aria-busy"], false);
  button.props.onClick(event());
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].options.signal, calls[0].options.signal);
});

test("caller preventDefault blocks download and explicit disabled survives completion", async (t) => {
  let clicks = 0;
  const { calls, render } = await setup(t, { onClick(e) { clicks++; e.preventDefault(); } });
  render().props.onClick(event());
  assert.equal(clicks, 1);
  assert.equal(calls.length, 0);
  render({ onClick: undefined }).props.onClick(event());
  calls[0].resolve(); await settle();
  assert.equal(render({ disabled: true }).props.disabled, true);
  assert.equal(render().props["aria-busy"], false);
});

for (const change of [
  { name: "file", props: { filePath: "/workspace/two.txt" } },
  { name: "session", props: { sessionId: "s2" } },
  { name: "source", props: { source: "bash-output" } },
]) {
  test(`${change.name} change cancels old request; late failure cannot reset new in-flight download`, async (t) => {
    const { hooks, calls, render } = await setup(t);
    render().props.onClick(event());
    render(change.props); hooks.flushEffects();
    assert.equal(calls[0].options.signal.aborted, true);
    let button = render();
    assert.equal(button.props.disabled, false);
    button.props.onClick(event());
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.signal.aborted, false);
    calls[0].reject(new Error("Bearer private-token ticket=private-ticket"));
    await settle();
    button = render();
    assert.equal(button.props["aria-busy"], true);
    assert.equal(button.props.title, "Download");
    button.props.onClick(event());
    assert.equal(calls.length, 2);
    calls[1].resolve(); await settle();
    assert.equal(render().props["aria-busy"], false);
  });
}

test("unmount cancels pending download and safely ignores its late rejection", async (t) => {
  const { hooks, calls, render } = await setup(t);
  render().props.onClick(event());
  hooks.cleanup();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].reject(new Error("Bearer private-token"));
  await settle();
});

test("failure exposes only generic retry text, restores availability and clears error on retry", async (t) => {
  const { calls, render } = await setup(t);
  render().props.onClick(event());
  calls[0].reject(new Error("https://service.test/content?ticket=secret-ticket Bearer private-token"));
  await settle();
  let button = render();
  assert.equal(button.props.title, "Download failed. Click to retry.");
  assert.doesNotMatch(button.props.title, /secret-ticket|private-token/);
  assert.equal(button.props.disabled, false);
  button.props.onClick(event());
  button = render();
  assert.equal(button.props.title, "Download");
  assert.equal(button.props.disabled, true);
  assert.equal(calls.length, 2);
  calls[1].resolve(); await settle();
  assert.equal(render().props.title, "Download");
});

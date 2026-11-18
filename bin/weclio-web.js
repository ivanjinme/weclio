#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");
const { assertUiOnlyBuild } = require("./ui-build");
const { parseLaunchOptions } = require("./weclio-web-options");

async function main() {
  if (!isNodeVersionSupported(process.versions.node)) throw new Error(getUnsupportedNodeVersionMessage(process.versions.node));
  const root = path.join(__dirname, "..");
  const args = process.argv.slice(2);
  if (args[0] !== "service") assertUiOnlyBuild(path.join(root, ".next"));
  const { runWeb, runStandalone } = await import("./web-host.mjs");
  if (args[0] === "service") {
    if (args.length !== 1) throw new Error("Configure standalone Agent Service with WECLIO_AGENT_* environment variables.");
    await runStandalone(root);
  } else {
    await runWeb(root, parseLaunchOptions(args));
  }
}

main().catch((error) => {
  console.error(`[weclio-web] ${error.message}`);
  process.exitCode = 1;
});

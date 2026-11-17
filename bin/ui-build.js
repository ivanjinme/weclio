"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const UI_ENTRIES = new Map([
  ["/page", "app/page.js"],
  ["/_not-found/page", "app/_not-found/page.js"],
  ["/_global-error/page", "app/_global-error/page.js"],
  // Next 从静态 favicon.ico 自动生成；不是业务 route handler。
  ["/favicon.ico/route", "app/favicon.ico/route.js"],
]);

function invalidBuild(reason) {
  return new Error(
    `Cannot start UI: old backend artifacts or an invalid UI build (${reason}). ` +
    "Rebuild the UI from the current UI-only source in a clean build directory before starting; do not reuse this .next build.",
  );
}

function assertUiOnlyBuild(nextDir) {
  for (const filename of ["instrumentation.js", "instrumentation-node.js"]) {
    try {
      fs.lstatSync(path.join(nextDir, "server", filename));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw invalidBuild(`cannot inspect server/${filename}: ${error.message}`);
    }
    throw invalidBuild(`server/${filename} is a retired backend hook`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(nextDir, "server", "app-paths-manifest.json"), "utf8"));
  } catch (error) {
    throw invalidBuild(`missing or malformed server/app-paths-manifest.json: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      !Object.hasOwn(manifest, "/page")) {
    throw invalidBuild("app-paths-manifest.json must describe the current UI page");
  }
  for (const [route, output] of Object.entries(manifest)) {
    if (!UI_ENTRIES.has(route) || UI_ENTRIES.get(route) !== output) {
      throw invalidBuild(`unexpected app entry ${route}`);
    }
  }
}

module.exports = { assertUiOnlyBuild };

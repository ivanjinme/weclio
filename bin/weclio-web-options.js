"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
      "service-url": { type: "string" },
      "token-file": { type: "string" },
    },
    strict: true,
  });

  const serviceUrl = cliArgs["service-url"];
  const tokenFile = cliArgs["token-file"];
  if ((serviceUrl !== undefined || tokenFile !== undefined) && (!serviceUrl || !tokenFile)) {
    throw new Error("Provide --service-url and --token-file together.");
  }
  return {
    ...(serviceUrl ? { attach: { serviceUrl, tokenFile } } : {}),
    port: cliArgs.port ?? env.PORT ?? "8888",
    hostname: cliArgs.hostname ?? env.WECLIO_HOST ?? "127.0.0.1",
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.WECLIO_NO_OPEN),
  };
}

module.exports = { parseLaunchOptions };

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

for (const transport of [false, true]) {
  test(`update fixture serves ${transport ? "transport test bytes" : "the current installer"} on a dynamically assigned port`, { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "weclio-update-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "electron", "update-fixture.mjs");
    const dist = join(root, "build", "desktop", "dist");
    await mkdir(join(root, "electron"));
    await mkdir(dist, { recursive: true });
    await copyFile(new URL("./update-fixture.mjs", import.meta.url), script);
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(join(dist, "Weclio-1.2.3-x64-Setup.exe"), "CURRENT INSTALLER FIXTURE");
    const child = spawn(process.execPath, [script, ...(transport ? ["--transport-test"] : [])], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    try {
      let feed;
      const lines = createInterface({ input: child.stdout });
      for await (const line of lines) {
        if (line.startsWith("Feed: ")) { feed = line.split(" ")[1]; break; }
      }
      assert.ok(feed, stderr);
      const feedUrl = new URL(feed);
      assert.equal(feedUrl.hostname, "127.0.0.1");
      assert.notEqual(feedUrl.port, "8899", "must not take the default dev Service port");
      const config = JSON.parse(await readFile(join(root, "build", "desktop", "update-fixture", "desktop-update.json"), "utf8"));
      assert.equal(config.manifestUrl, feed);
      assert.equal(config.devFixture, true);
      const { payload } = await (await fetch(feed)).json();
      const { files: [file] } = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      assert.equal(new URL(file.url).origin, feedUrl.origin);
      const response = await fetch(file.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), transport ? "NOT AN INSTALLER — download transport test only\n" : "CURRENT INSTALLER FIXTURE");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
}

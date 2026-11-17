import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
test("only an explicitly managed Service treats parent stdin EOF as shutdown", { timeout: 30000 }, async (t) => {
  for (const managed of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "weclio-parent-pipe-"));
    const home = join(root, "home");
    const agent = join(home, ".pi/agent");
    await mkdir(agent, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", WECLIO_AGENT_STATE_DIR: join(root, "state"), WECLIO_AGENT_WORKSPACE: join(root, "workspace"), WECLIO_AGENT_PORT: "0", ...(managed ? { WECLIO_AGENT_PARENT_STDIN: "1" } : {}) });
    const jiti = pathToFileURL(require.resolve("jiti")).href;
    const entry = pathToFileURL(fileURLToPath(new URL("./entry.ts", import.meta.url))).href;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `const {createJiti}=await import(${JSON.stringify(jiti)}); const entry=await createJiti(import.meta.url).import(${JSON.stringify(entry)});await entry.main();`], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No ready: ${stderr}`)), 12000);
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Early exit ${code}: ${stderr}`)); });
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const line = stdout.split(/\r?\n/).find((item) => item.startsWith("WECLIO_AGENT_READY "));
          if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice("WECLIO_AGENT_READY ".length))); }
        });
      });
      child.stdin.end();
      if (managed) {
        let timer;
        try {
          assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Managed Service did not exit on EOF")), 5000); })]), 0);
        } finally { clearTimeout(timer); }
        assert.match(stdout, /WECLIO_AGENT_CLOSED/);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal((await fetch(`${ready.url}/healthz`)).status, 200);
        assert.equal(child.exitCode, null);
      }
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  t.diagnostic("Standalone stdin EOF is harmless; owned parent loss drains the managed instance.");
});

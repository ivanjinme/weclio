import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

// 首次启动时目录可能还不存在；解析已有祖先，避免通过目录别名绕过互斥。
function canonicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}

export async function acquireServiceOwnership(directories: string[]): Promise<() => Promise<void>> {
  if (process.platform !== "win32" && process.platform !== "linux") throw new Error("Local Agent Service ownership requires Windows or Linux.");
  const names = new Map<string, string>();
  for (const directory of directories) {
    const canonical = canonicalPath(resolve(directory));
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    names.set(key, directory);
  }
  const servers: ReturnType<typeof createServer>[] = [];
  const release = async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  };
  try {
    for (const [key, directory] of names) {
      const name = "weclio-agent-" + createHash("sha256").update(key).digest("hex");
      const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `\0${name}`;
      // 仅占有内核端点，不提供任何命令；进程崩溃后由 OS 释放。
      const server = createServer((socket) => socket.destroy());
      try {
        server.listen({ path: endpoint, exclusive: true });
        await once(server, "listening");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new Error(`Another Agent Service already owns ${directory}. Connect to it explicitly or stop it first.`, { cause: error });
        }
        throw error;
      }
      servers.push(server);
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

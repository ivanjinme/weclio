import { execFileSync } from "node:child_process";
import { test } from "node:test";

const mockUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const launcherUrl = new URL("./dev.mjs", import.meta.url).href;
const supervisorUrl = new URL("./dev-service-ui.mjs", import.meta.url).href;

function run(script) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: "pipe" });
}

for (const fails of [false, true]) {
  test(`desktop wrapper is import-safe and delegates runtime, GUI arguments and logs${fails ? " on failure" : ""}`, () => {
    const mocks = {
      electron: "export default 'test-electron.exe';",
      "node:fs": `export const writes = [];
        export function mkdirSync() {}
        export function writeFileSync(path, content) { writes.push({path, content}); }
        export function appendFileSync(path, content) { writes.push({path, content}); }`,
      "./dev-service-ui.mjs": `export const calls = [];
        export async function main(options) {
          calls.push(options);
          options.onOutput('[service] service log\\n');
          options.onOutput('[ui] ui log\\n');
          ${fails ? "throw new Error('fixture failure');" : ""}
        }`,
    };
    run(`
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const mocks = ${JSON.stringify(Object.fromEntries(Object.entries(mocks).map(([key, value]) => [key, mockUrl(value)])))};
      registerHooks({ resolve(specifier, context, next) {
        return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : next(specifier, context);
      }});
      const { calls } = await import('./dev-service-ui.mjs');
      const { writes } = await import('node:fs');
      const { main } = await import(${JSON.stringify(launcherUrl)});
      assert.equal(calls.length, 0);
      assert.equal(writes.length, 0);
      const env = { Path: 'C:/user/Git/cmd;C:/user/Git/bin', PORT: '18889', CUSTOM: 'kept' };
      const result = main({ env, args: ['--fixture'] });
      ${fails ? "await assert.rejects(result, /fixture failure/);" : "await result;"}
      assert.equal(calls.length, 1);
      const options = calls[0];
      assert.equal(options.env.PORT, '18889');
      assert.equal(options.env.CUSTOM, 'kept');
      assert.equal(options.env.Path, undefined);
      assert.ok(options.env.PATH.startsWith(env.Path + ';'));
      assert.match(options.env.PATH, /resources[\\\\/]runtime[\\\\/]win-x64[\\\\/]tools$/);
      assert.equal(options.desktop.executable, 'test-electron.exe');
      assert.match(options.desktop.args[0], /electron[\\\\/]main.mjs$/);
      assert.equal(options.desktop.args[1], '--fixture');
      assert.ok(writes.every(write => /node_modules[\\\\/].cache[\\\\/]weclio-desktop.log$/.test(write.path)));
      assert.ok(writes.some(write => write.content.includes('[ui] ui log')));
      assert.ok(writes.some(write => write.content.includes(${JSON.stringify(fails ? "fixture failure" : "停止启动器 (0)")})));
    `);
  });
}

for (const parentExitsFirst of [false, true]) {
  test(`shared POSIX shutdown cleans process groups when leaders exit ${parentExitsFirst ? "before shutdown" : "during the grace period"}`, () => {
    const mocks = {
      "node:child_process": `
        import { EventEmitter } from 'node:events';
        export const children = [];
        export function spawn(command, args, options) {
          const child = Object.assign(new EventEmitter(), {
            pid: 10000 + children.length,
            stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
            stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
            exitCode: null, signalCode: null
          });
          children.push(child);
          if (children.length === 1) setImmediate(() => child.stdout.emit('data',
            'WECLIO_AGENT_READY ' + JSON.stringify({url: 'http://127.0.0.1:18890'}) + '\\n'));
          return child;
        }
        export function spawnSync() { throw new Error('Unexpected taskkill on POSIX'); }
      `,
      "node:fs": "export function existsSync(path) { return path.endsWith('index.html'); } export function readFileSync() { return 'fixture-token'; }",
      "node:net": `import { EventEmitter } from 'node:events';
        export function createServer() {
          return Object.assign(new EventEmitter(), { listen(options, ready) { ready(); }, close(done) { done(); } });
        }`,
    };
    run(`
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const mocks = ${JSON.stringify(Object.fromEntries(Object.entries(mocks).map(([key, value]) => [key, mockUrl(value)])))};
      registerHooks({ resolve(specifier, context, next) {
        return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : next(specifier, context);
      }});
      const { children } = await import('node:child_process');
      const signals = [];
      process.kill = (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') {
          const child = children.find(child => child.pid === -pid);
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      };
      const { main } = await import(${JSON.stringify(supervisorUrl)});
      const assetDir = '/fixture-desktop-ui';
      const running = main({ env: { WECLIO_DEV_SERVICE_PORT: '18890', WECLIO_DESKTOP_UI_DIR: assetDir },
        desktop: { executable: 'test-electron', args: [] } });
      while (children.length < 2) await new Promise(resolve => setImmediate(resolve));
      if (${parentExitsFirst}) {
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
      } else process.emit('SIGINT');
      await running;
      for (const child of children) {
        assert.ok(signals.some(call => call.pid === -child.pid && call.signal === 'SIGTERM'));
        assert.ok(signals.some(call => call.pid === -child.pid && call.signal === 'SIGKILL'),
          'must clean the group even after its leader exits');
      }
      process.kill = () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); };
    `);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./api-bootstrap.ts", import.meta.url), "utf8");
// 注入模块依赖，直接验证启动副作用，不依赖 Next/Vite 的构建产物。
const script = new vm.Script(source.replace(/^import .*;$/gm, ""));

function bootstrap(env, initiallyConfigured = false) {
  let configured = initiallyConfigured;
  const bases = [];
  const tokens = [];
  script.runInNewContext({
    ...(env === undefined ? {} : { process: { env } }),
    configureApiBase: (base) => { bases.push(base); configured = true; },
    isApiBaseConfigured: () => configured,
    setAgentCredential: (token) => tokens.push(token),
  });
  return { bases, tokens };
}

test("static bootstrap without process stays unconfigured and does not crash", () => {
  const { bases, tokens } = bootstrap();
  assert.equal(bases.length, 0);
  assert.equal(tokens.length, 0);
});

test("dev bootstrap selects the Service before setting its in-memory token", () => {
  const { bases, tokens } = bootstrap({
    NEXT_PUBLIC_WECLIO_API_URL: "http://127.0.0.1:9001",
    NEXT_PUBLIC_WECLIO_AGENT_TOKEN: "dev-token",
  });
  assert.equal(bases.length, 1);
  assert.equal(bases[0].baseUrl, "http://127.0.0.1:9001");
  assert.equal(bases[0].basePath, undefined);
  assert.deepEqual(tokens, ["dev-token"]);
});

test("a token alone does not select an implicit same-origin backend", () => {
  const { bases, tokens } = bootstrap({ NEXT_PUBLIC_WECLIO_AGENT_TOKEN: "orphan-token" });
  assert.equal(bases.length, 0);
  assert.equal(tokens.length, 0);
});

test("startup environment does not overwrite an explicitly configured Service", () => {
  const { bases } = bootstrap({ NEXT_PUBLIC_WECLIO_API_URL: "https://other.example" }, true);
  assert.equal(bases.length, 0);
});

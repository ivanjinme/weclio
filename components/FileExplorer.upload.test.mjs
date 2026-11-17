import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { apiUrl, configureApiBase, resetApiBase } = await jiti.import("../lib/api-base.ts");
const { agentAuthHeaders, setAgentCredential, resetAgentCredential } = await jiti.import("../lib/agent-credential.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const start = source.indexOf("function uploadFiles(");
const end = source.indexOf("\nfunction MentionIcon", start);
assert.ok(start >= 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const uploadFiles = new Function("apiUrl", "agentAuthHeaders", "encodeFilePathForApi", `${compiled}\nreturn uploadFiles;`)(
  apiUrl, agentAuthHeaders, encodeFilePathForApi,
);

test("XHR uploads attach selected Service auth and retain multipart body and progress; Next stays anonymous", async (t) => {
  t.after(() => { resetApiBase(); resetAgentCredential(); });
  const requests = [];
  class FakeXHR {
    upload = {};
    headers = new Headers();
    status = 200;
    responseText = '{"uploaded":["sample.txt"]}';
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers.set(name, value); }
    send(body) {
      this.body = body;
      requests.push(this);
      this.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
      this.onload();
    }
  }
  const originalXHR = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXHR });
  t.after(() => {
    if (originalXHR) Object.defineProperty(globalThis, "XMLHttpRequest", originalXHR);
    else delete globalThis.XMLHttpRequest;
  });
  const file = new File(["sample"], "sample.txt");
  configureApiBase({ baseUrl: "https://service.test", basePath: "/v1" });
  setAgentCredential("upload-token");
  const progress = [];
  const result = await uploadFiles("/workspace", [file], "overwrite", (value) => progress.push(value));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.uploaded, ["sample.txt"]);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /^https:\/\/service\.test\/v1\/files\//);
  assert.match(requests[0].url, /type=upload&conflict=overwrite$/);
  assert.equal(requests[0].headers.get("authorization"), "Bearer upload-token");
  assert.equal(requests[0].headers.get("content-type"), null);
  assert.ok(requests[0].body instanceof FormData);
  assert.equal(requests[0].body.get("files").name, "sample.txt");
  assert.deepEqual(progress, [50]);

  resetApiBase();
  resetAgentCredential();
  await uploadFiles("/workspace", [file], "skip", () => {});
  assert.match(requests[1].url, /^\/api\/files\//);
  assert.equal(requests[1].headers.get("authorization"), null);
  assert.equal(requests[1].headers.get("content-type"), null);
});

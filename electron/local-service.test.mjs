import { execFileSync } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("./local-service.mjs", import.meta.url).href;
function scenario(mode, check) {
  const script = `
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'weclio-local-host-'));
const service = join(root, 'service'); mkdirSync(service);
mkdirSync(join(root, 'ui')); writeFileSync(join(root, 'ui/index.html'), '<title>fixture</title>');
const runtimeMock = 'export async function verifyNodeRuntime(root){return {root:'+JSON.stringify(dirname(process.execPath))+',executable:'+JSON.stringify(process.execPath)+'}}';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './node-runtime.mjs') return { url: 'data:text/javascript,' + encodeURIComponent(runtimeMock), shortCircuit: true };
  return next(specifier, context);
}});
const code = ${JSON.stringify(`
import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
const state=process.env.WECLIO_AGENT_STATE_DIR;
writeFileSync(join(state,'seen.json'), JSON.stringify({executable:process.execPath,electron:process.env.ELECTRON_RUN_AS_NODE,options:process.env.NODE_OPTIONS,path:process.env.PATH,origins:process.env.WECLIO_AGENT_ALLOWED_ORIGINS,parent:process.env.WECLIO_AGENT_PARENT_STDIN}));
writeFileSync(join(state,'service-token'),'fixture-private-token');
process.stdin.setEncoding('utf8');let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf(String.fromCharCode(10)))!==-1){const line=pending.slice(0,i);pending=pending.slice(i+1);if(line.trim()==='shutdown')process.exit(0);const request=JSON.parse(line);const status=request.action==='inspect'?process.env.FIXTURE_INSPECT:request.action==='lock'?process.env.FIXTURE_LOCK:'unlocked';process.stdout.write('WECLIO_AGENT_CONTROL '+JSON.stringify({id:request.id,status,chunked:true}).slice(0,1));setTimeout(()=>process.stdout.write(JSON.stringify({id:request.id,status}).slice(1)+String.fromCharCode(10)),5)}});process.stdin.resume();
const server=createServer((req,res)=>{
  if(${JSON.stringify(mode)}==='unauthorized'){res.writeHead(403);res.end('{}');return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({serviceId:'service',instanceId:${JSON.stringify(mode)}==='identity'?'foreign':'instance',protocol:{version:${JSON.stringify(mode)}==='protocol'?99:1,minClient:1}}));
});
server.listen(0,'127.0.0.1',()=>{
 writeFileSync(join(state,'service.json'), JSON.stringify({pid:process.pid,instanceId:'instance'}));
 if(${JSON.stringify(mode)}==='early-exit'){process.exit(7);return;}
 if(${JSON.stringify(mode)}==='cancel')return;
 process.stdout.write('WECLIO_AGENT_');setTimeout(()=>console.log('READY '+JSON.stringify({url:'http://127.0.0.1:'+server.address().port,serviceId:'service',instanceId:'instance'})),10);
});
`) };
writeFileSync(join(service,'entry.mjs'), code);
const {startLocalAgentService}=await import(${JSON.stringify(moduleUrl)});
const controller=new AbortController();
const options={resourcesPath:root,stateDir:join(root,'state'),logsPath:join(root,'logs'),appVersion:'test',toolsRoot:root,signal:controller.signal,env:{...process.env,FIXTURE_INSPECT:'busy',FIXTURE_LOCK:'ready',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--require forbidden',NODE_PATH:'forbidden'}};
let started;
try {
  ${check}
} finally {
  if(started)await started.stop();
  rmSync(root,{recursive:true,force:true,maxRetries:3});
}
`;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: "pipe", timeout: 30000 });
}

test("owned Service readiness requires authentication and matching identity; plain Node env and graceful stop", () => {
  scenario("ok", `
started=await startLocalAgentService(options);
assert.equal(new URL(started.baseUrl).hostname,'127.0.0.1');
assert.equal(new URL(started.baseUrl).protocol,'http:');
assert.equal(started.token,'fixture-private-token');
assert.equal(started.uiDir,join(root,'ui'));
const seen=JSON.parse(readFileSync(join(root,'state/seen.json'),'utf8'));
assert.equal(seen.executable,process.execPath);
assert.equal(seen.electron,undefined);assert.equal(seen.options,undefined);
assert.equal(seen.origins,'weclio://app');assert.equal(seen.parent,'1');
assert.equal(await started.control.inspect(),'busy');
assert.equal(await started.control.lock(),'ready');
assert.equal(await started.control.unlock(),'unlocked');
await started.stop(); await started.stop();
await assert.rejects(started.control.inspect(),/unavailable/);
assert.throws(()=>process.kill(started.pid,0),/ESRCH/);
`);
});
for (const mode of ["identity", "protocol", "unauthorized", "early-exit"]) {
  test(`startup rejects ${mode} without leaving its owned child running`, () => {
    scenario(mode, `
await assert.rejects(startLocalAgentService(options),/身份或协议不匹配|authentication failed|已退出/);
const identity=JSON.parse(readFileSync(join(root,'state/service.json'),'utf8'));
assert.throws(()=>process.kill(identity.pid,0),/ESRCH/);
`);
  });
}
test("cancelling startup stops the owned Service before returning", () => {
  scenario("cancel", `
const starting=startLocalAgentService(options);
setTimeout(()=>controller.abort(),300);
await assert.rejects(starting,/aborted|cancelled/);
const identity=JSON.parse(readFileSync(join(root,'state/service.json'),'utf8'));
assert.throws(()=>process.kill(identity.pid,0),/ESRCH/);
`);
});

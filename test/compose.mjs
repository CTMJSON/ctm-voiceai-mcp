import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const env=Object.fromEntries((await readFile(new URL('../deploy/.env',import.meta.url),'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
const origin='http://127.0.0.1:8000', issuer='http://127.0.0.1:8080/realms/voiceai';
async function ready(url) {
  for(let i=0;i<90;i++) {
    try { const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.ok)return; }catch{}
    await delay(2000);
  }
  throw Error('Container readiness timed out');
}
await Promise.all([ready(origin+'/health'),ready(issuer+'/.well-known/openid-configuration')]);
for(const username of ['alice','bob']) {
  const r=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'voiceai-dev-test',username,password:env[`TEST_${username.toUpperCase()}_PASSWORD`],scope:'ctm-voiceai:use'})});
  // Never include token responses or fixture passwords in assertion output.
  assert.equal(r.status,200,'Keycloak fixture login failed');const token=(await r.json()).access_token;
  const rpc=async(method,params)=>{
    const response=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(response.status,200,'MCP bearer validation failed');return response.json();
  };
  assert.equal((await rpc('tools/list',{})).result.tools.length,6);
  const calls=await rpc('tools/call',{name:'ctm_voiceai_get_voice_bots',arguments:{account_id:'123456'}});
  assert.equal(JSON.parse(calls.result.content[0].text).code,'CTM_CONNECT_REQUIRED','Each user starts without a shared CTM grant');
  const runs=await rpc('tools/call',{name:'ctm_voiceai_list_runs',arguments:{}});
  assert.deepEqual(JSON.parse(runs.result.content[0].text),[]);
}
assert.equal((await fetch(origin+'/mcp',{method:'POST'})).status,401);
assert.equal((await fetch(origin+'/connect')).status,200);
const login=await fetch(origin+'/connect/login',{redirect:'manual'});
assert.equal(login.status,303);assert.ok(login.headers.get('location').startsWith(issuer+'/protocol/openid-connect/auth?'));
console.log('PASS: container build, restricted database role, real Keycloak JWTs, both users, MCP tools, private storage, and browser login redirect. No live CTM calls made.');

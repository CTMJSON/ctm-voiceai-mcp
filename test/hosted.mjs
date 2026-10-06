import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { createVerifier, ownerKey } from '../dist/hosted/identity.js';
import { Sealer } from '../dist/hosted/crypto.js';
import { hostedConfig } from '../dist/hosted/config.js';
import { HostedOAuth } from '../dist/hosted/oauth.js';
import { createHostedHttp } from '../dist/hosted/http.js';
import { renderReport, reportCsp } from '../dist/hosted/render.js';
import { AppError } from '../dist/errors.js';
import { MemoryStore, credential, artifacts } from './hosted-fixtures.mjs';

const keys=await generateKeyPair('RS256'), wrongKeys=await generateKeyPair('RS256');
const issuer='https://identity.example.test/realm';
const audience='https://mcp.example.test/mcp';
const verify=createVerifier({issuer,audience,jwksUrl:new URL(issuer+'/keys'),requiredScope:'ctm-voiceai:use'},createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256'}]}));
const jwt = (subject='alice',extra={},key=keys.privateKey) => new SignJWT({scope:'ctm-voiceai:use',...extra}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(extra.iss??issuer).setAudience(extra.aud??audience).setSubject(subject).setIssuedAt().setExpirationTime(extra.exp??'15m').sign(key);
const alice=await verify(await jwt('alice')), bob=await verify(await jwt('bob'));
const config={publicUrl:'https://mcp.example.test',oidcClientId:'portal',oidcAuthorizeUrl:issuer+'/authorize',oidcTokenUrl:issuer+'/token',ctmClientId:'fixture-client',ctmAuthorizeUrl:'https://ctm.example.test/authorize',ctmTokenUrl:'https://ctm.example.test/token'};
const tokenResponse=(extra={})=>new Response(JSON.stringify({access_token:'fixture-new-access',refresh_token:'fixture-new-refresh',token_type:'Bearer',expires_in:3600,scope:'profile activity reports manage',...extra}),{status:200});

test('JWT signature, issuer, audience, expiration and MCP scope are enforced',async()=>{
  assert.equal((await verify(await jwt())).owner,ownerKey(issuer,'alice'));
  for(const token of [await jwt('alice',{},wrongKeys.privateKey),await jwt('alice',{iss:'https://attacker.example'}),await jwt('alice',{aud:'different-service'}),await jwt('alice',{exp:1}),'garbage']) await assert.rejects(verify(token),e=>e.code==='UNAUTHORIZED');
  await assert.rejects(verify(await jwt('alice',{scope:'openid'})),e=>e.code==='FORBIDDEN');
  const noExpiry=await new SignJWT({iss:issuer,sub:'alice',aud:audience,iat:1,scope:'ctm-voiceai:use'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(keys.privateKey);
  await assert.rejects(verify(noExpiry));
  assert.notEqual(ownerKey(issuer,'alice'),ownerKey('https://other-issuer','alice'));
});
test('encryption binds ciphertext to owner, purpose, and random nonce',()=>{
  const sealer=new Sealer(randomBytes(32).toString('base64'));
  const value=credential('alice');const sealed=sealer.seal(value,'alice:credentials');
  assert.deepEqual(sealer.open(sealed,'alice:credentials'),value);
  assert.ok(!sealed.includes(value.accessToken));assert.notEqual(sealer.seal(value,'alice:credentials'),sealed);
  assert.throws(()=>sealer.open(sealed,'bob:credentials'));assert.throws(()=>sealer.open(sealed,'alice:report'));
});
test('OAuth PKCE binds consent to user and browser, rejects replay, and omits client secrets',async()=>{
  const store=new MemoryStore();const forms=[];
  const oauth=new HostedOAuth(store,config,verify,async(url,init)=>{forms.push(new URLSearchParams(init.body));return tokenResponse();});
  const url=new URL(await oauth.beginCtm(alice,'alice-browser'));const state=url.searchParams.get('state');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('scope').includes('manage'));
  await assert.rejects(oauth.finishCtm(bob,'alice-browser',state,'code'),e=>e.code==='OAUTH_STATE');
  await assert.rejects(oauth.finishCtm(alice,'different-browser',state,'code'),e=>e.code==='OAUTH_STATE');
  assert.equal(forms.length,0);
  await oauth.finishCtm(alice,'alice-browser',state,'code');assert.equal(forms.length,1);
  assert.ok(forms[0].get('code_verifier'));assert.equal(forms[0].get('client_secret'),null);
  await assert.rejects(oauth.finishCtm(alice,'alice-browser',state,'code'));
  assert.equal(await oauth.forAccount(alice,'123456'),'fixture-new-access');
  await assert.rejects(oauth.forAccount(bob,'123456'),e=>e.code==='CTM_CONNECT_REQUIRED');
});
test('OIDC sign-in checks state and cannot reuse or expire a browser session',async()=>{
  const store=new MemoryStore();const access=await jwt();
  const oauth=new HostedOAuth(store,config,verify,async()=>tokenResponse({access_token:access}));
  const flow=await oauth.beginLogin();await assert.rejects(oauth.finishLogin(flow.state,'wrong','code'));
  const browser=await oauth.finishLogin(flow.state,flow.state,'code');assert.equal((await oauth.browserCaller(browser)).owner,alice.owner);
  await assert.rejects(oauth.finishLogin(flow.state,flow.state,'code'));
  store.sessions.get(browser).expiresAt=1;await assert.rejects(oauth.browserCaller(browser));
});
test('parallel refresh is serialized per user; errors invalidate ambiguous token rotation',async()=>{
  const store=new MemoryStore();await store.credentials(alice.owner,async(_,save)=>save(credential('alice',{expiresAt:1})));
  await store.credentials(bob.owner,async(_,save)=>save(credential('bob')));
  let count=0;const oauth=new HostedOAuth(store,config,verify,async()=>{count++;return tokenResponse();});
  assert.deepEqual(await Promise.all([oauth.forAccount(alice,'123456'),oauth.forAccount(alice,'123456'),oauth.forAccount(bob,'123456')]),['fixture-new-access','fixture-new-access','fixture-ctm-access-bob']);
  assert.equal(count,1);
  await store.credentials(alice.owner,async(_,save)=>save(credential('alice',{expiresAt:1})));
  const broken=new HostedOAuth(store,config,verify,async()=>{throw Error('upstream secret must not escape');});
  await assert.rejects(broken.forAccount(alice,'123456'),e=>e.code==='OAUTH_NETWORK'&&!e.message.includes('secret'));
  assert.equal(await store.credentials(alice.owner,async current=>current),null);
  assert.equal(await oauth.forAccount(bob,'123456'),'fixture-ctm-access-bob');
});
test('account-scoped grants cannot request another account before or after refresh',async()=>{
  const store=new MemoryStore();await store.credentials(alice.owner,async(_,save)=>save(credential('alice',{accountId:'654321'})));
  const oauth=new HostedOAuth(store,config,verify,async()=>tokenResponse({account_id:'654321'}));
  await assert.rejects(oauth.forAccount(alice,'123456'),e=>e.code==='FORBIDDEN');
  await store.credentials(alice.owner,async(_,save)=>save(credential('alice',{expiresAt:1})));
  await assert.rejects(oauth.forAccount(alice,'123456'),e=>e.code==='FORBIDDEN');
  assert.equal(await store.credentials(alice.owner,async current=>current),null);
});
test('report renderer escapes HTML/script content and spreadsheet formulas',()=>{
  const malicious={...artifacts,topics:[{name:'=HYPERLINK("bad")',description:'<img src=x onerror=alert(1)>'}],rewrites:[{text:'</pre><script>alert(1)</script>'}]};
  const html=renderReport(malicious,'html');assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(reportCsp.includes("default-src 'none'"));
  assert.ok(renderReport(malicious,'csv').includes("\"'=HYPERLINK"));
});
test('hosted config fails closed and never reads local OAuth or Basic auth variables',()=>{
  assert.throws(()=>hostedConfig({CTM_BASIC_AUTH:'fixture',CTM_OAUTH_CLIENT_ID:'local'}));
  const env={HOSTED_PUBLIC_URL:'http://127.0.0.1:8000',OIDC_ISSUER:'http://127.0.0.1:8080/realms/voiceai',OIDC_JWKS_URL:'http://keycloak:8080/keys',OIDC_AUTHORIZE_URL:'http://127.0.0.1:8080/auth',OIDC_TOKEN_URL:'http://keycloak:8080/token',OIDC_PORTAL_CLIENT_ID:'portal',CTM_HOSTED_CLIENT_ID:'fixture',DATABASE_URL:'postgresql://fixture',HOSTED_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
  assert.throws(()=>hostedConfig(env));assert.equal(hostedConfig({...env,HOSTED_DEV_MODE:'1'}).identity.audience,'http://127.0.0.1:8000/mcp');
});
test('real HTTP MCP isolates concurrent identities, report reads, resources, listings, and CTM tokens',async t=>{
  const store=new MemoryStore();for(const c of [alice,bob]) await store.credentials(c.owner,async(_,save)=>save(credential(c.subject)));
  const oauth=new HostedOAuth(store,config,verify);const calls=[];let deny=false;
  const ctm={bots:async(account,header)=>{calls.push({account,header});if(deny)throw new AppError('CTM API request failed (HTTP 403).','API_ERROR',403);return [{id:'fixture-bot',name:'Example',instructions:header.endsWith('alice')?'Alice instructions':'Bob instructions'}];},calls:async(account,header)=>{calls.push({account,header});return {page:1,per_page:25,returned:1,with_transcript:1,total:1,total_pages:1,has_more:false,next_page:null,calls:[{id:'fixture',transcript:'Example transcript',summary:'',direction:'inbound',occurred_at:null}]};}};
  // Reserve an ephemeral port; configured public origin is updated before requests.
  const options={store,credentials:oauth,oauth,ctm,verify,issuer,dev:true,retentionDays:7,publicUrl:'http://127.0.0.1:1'};
  // Host is intentionally fixed; listen then discover port via a small second bind.
  const net=await import('node:net');const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  options.publicUrl=`http://127.0.0.1:${port}`;
  const server=createHostedHttp(options);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const tokens={alice:await jwt('alice'),bob:await jwt('bob')};
  const request=(path,opts={})=>fetch(options.publicUrl+path,opts);
  const rpc=async(user,method,params={},extra={})=>{
    const r=await request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${tokens[user]}`,Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25',...extra},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
    const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;
  };
  const tool=async(user,name,args,extra)=>{const r=await rpc(user,'tools/call',{name:'ctm_voiceai_'+name,arguments:args},extra);return r.result?.content ? {value:JSON.parse(r.result.content[0].text),isError:r.result.isError}:r;};
  const unauthorized=await request('/mcp',{method:'POST'});assert.equal(unauthorized.status,401);assert.ok(unauthorized.headers.get('www-authenticate').includes('resource_metadata'));
  const bad=await request('/mcp',{method:'POST',headers:{Authorization:'Bearer forged','X-User-Id':alice.subject}});assert.equal(bad.status,401);
  const discovery=await request('/.well-known/oauth-protected-resource/mcp');assert.equal((await discovery.json()).resource,options.publicUrl+'/mcp');
  const list=await rpc('alice','tools/list');assert.equal(list.result.tools.length,6);assert.ok(!JSON.stringify(list).includes('auth_login'));assert.ok(!JSON.stringify(list).includes('out_dir'));
  const results=await Promise.all([tool('alice','get_voice_bots',{account_id:'123456'}),tool('bob','get_voice_bots',{account_id:'123456'},{'Mcp-Session-Id':'alice-session','X-User-Id':alice.subject})]);
  assert.equal(results[0].value.bots[0].instructions,'Alice instructions');assert.equal(results[1].value.bots[0].instructions,'Bob instructions');
  assert.deepEqual(calls.map(c=>c.header),['Bearer fixture-ctm-access-alice','Bearer fixture-ctm-access-bob']);
  const spoof=await rpc('bob','tools/call',{name:'ctm_voiceai_write_report',arguments:{...artifacts,idempotency_key:randomUUID(),owner:alice.owner}});assert.ok(spoof.error || spoof.result.isError);
  const saved=await tool('alice','write_report',{...artifacts,idempotency_key:randomUUID()});assert.ok(!saved.isError,JSON.stringify(saved));const id=saved.value.run_id;
  const foreign=await tool('bob','get_report',{run_id:id});const missing=await tool('bob','get_report',{run_id:randomUUID()});assert.deepEqual(foreign,missing);assert.equal(foreign.value.code,'NOT_FOUND');
  assert.equal((await tool('bob','list_runs',{})).value.length,0);assert.equal((await tool('alice','list_runs',{})).value.length,1);
  const own=await tool('alice','get_report',{run_id:id});assert.ok(own.value.content.includes('Scheduling'));
  const otherResource=await rpc('bob','resources/read',{uri:`ctm-voiceai-report://${id}/json`});assert.ok(otherResource.error);assert.ok(!JSON.stringify(otherResource).includes('Scheduling'));
  const download=await request(`/reports/${id}/html`,{headers:{Authorization:`Bearer ${tokens.bob}`}});assert.equal(download.status,404);
  const ownDownload=await request(`/reports/${id}/html`,{headers:{Authorization:`Bearer ${tokens.alice}`}});assert.equal(ownDownload.status,200);assert.ok(ownDownload.headers.get('content-disposition').startsWith('attachment'));assert.ok((await ownDownload.text()).includes('Scheduling'));
  deny=true;assert.equal((await tool('alice','get_report',{run_id:id})).value.code,'API_ERROR');deny=false;
  const badOrigin=await request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${tokens.alice}`,Origin:'https://evil.example'}});assert.equal(badOrigin.status,403);
  const cookieOnly=await request('/mcp',{method:'POST',headers:{Cookie:'voiceai-session=fixture'}});assert.equal(cookieOnly.status,401);
  const csrf=await request('/connect/ctm',{method:'POST'});assert.equal(csrf.status,403);
  const serialized=JSON.stringify([saved,own,foreign,otherResource]);assert.ok(!serialized.includes('fixture-ctm-access'));assert.ok(!serialized.includes('fixture-ctm-refresh'));
});

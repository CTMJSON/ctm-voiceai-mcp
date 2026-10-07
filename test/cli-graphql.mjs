import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliGraphql } from '../dist/cli-graphql.js';
const root=await mkdtemp(join(tmpdir(),'voiceai-cli-'));
const file=join(root,'ctm.yml');const endpoint='https://app.ctm.com/graphql';
const session=()=>({graphql_token:'JWTGQL.fixture.secret',graphql_token_endpoint:endpoint,graphql_token_expires_at:new Date(Date.now()+3600000).toISOString(),api_token:'fixture-basic-must-never-be-used'});
const save=value=>writeFile(file,JSON.stringify(value),{mode:0o600});
beforeEach(()=>save(session()));after(()=>rm(root,{recursive:true,force:true}));
const wrap=(value,account='111111')=>new Response(JSON.stringify({data:{account:{legacyId:account,...value}}}));
const info=(more=false,cursor=null)=>({hasNextPage:more,endCursor:cursor});
const bot={legacyId:'fixture-agent',name:'Example',description:'',instructions:'Example instructions',playMessage:'Hello',classifierEnabled:false};
const call=(extra={})=>({legacyId:'fixture-call',direction:'INBOUND',occurredAt:'2026-10-01T00:00:00Z',status:'answered',transcription:'Example transcript',summary:'Example summary',...extra});

test('uses only CLI browser token, pinned HTTPS endpoint, variables, and no redirects',async()=>{
 let count=0;
 const api=new CliGraphql({cliConfigFile:file},async(url,options)=>{
  count++;assert.equal(url,endpoint);assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer JWTGQL.fixture.secret');
  const body=JSON.parse(options.body);assert.equal(body.variables.account,'111111');assert.ok(!body.query.includes('111111'));
  return wrap({voiceBots:{nodes:[bot],pageInfo:info()}});
 });
 assert.equal((await api.bots('111111'))[0].instructions,bot.instructions);assert.equal(count,1);
 assert.ok(!JSON.stringify(await api.status()).includes('secret'));
});
test('missing, expired, malformed and wrong-endpoint CLI sessions never use Basic fallback',async()=>{
 let requests=0;const api=new CliGraphql({cliConfigFile:file},async()=>{requests++;throw Error('unexpected');});
 for(const value of [{api_token:'fixture-basic'}, {...session(),graphql_token_expires_at:'2000-01-01'}, {...session(),graphql_token_endpoint:'https://other.example/graphql'}, {...session(),graphql_token:'Basic fixture'}, {...session(),graphql_token_expires_at:'invalid'}]){
  await save(value);await assert.rejects(api.bots('111111'),e=>e.code==='CLI_LOGIN_REQUIRED');assert.equal((await api.status()).logged_in,false);
 }
 await writeFile(file,'graphql_token: [invalid');await assert.rejects(api.bots('111111'));assert.equal(requests,0);
});
test('verifies account identity on every response, including later agent pages',async()=>{
 let n=0;const api=new CliGraphql({cliConfigFile:file},async()=>{n++;return wrap({voiceBots:{nodes:[bot],pageInfo:info(n===1,'cursor')}},n===1?'111111':'222222');});
 await assert.rejects(api.bots('111111'),e=>e.code==='ACCOUNT_MISMATCH');assert.equal(n,2);
 const calls=new CliGraphql({cliConfigFile:file},async()=>wrap({activities:{nodes:[call()],pageInfo:info()}},'222222'));
 await assert.rejects(calls.calls('111111'),e=>e.code==='ACCOUNT_MISMATCH');
});
test('agent pagination maps fields and rejects non-advancing cursors',async()=>{
 const cursors=[];const api=new CliGraphql({cliConfigFile:file},async(_,o)=>{cursors.push(JSON.parse(o.body).variables.after);return wrap({voiceBots:{nodes:[{...bot,legacyId:String(cursors.length)}],pageInfo:info(cursors.length===1,'next')}});});
 assert.equal((await api.bots('111111')).length,2);assert.deepEqual(cursors,[null,'next']);
 const stuck=new CliGraphql({cliConfigFile:file},async()=>wrap({voiceBots:{nodes:[bot],pageInfo:info(true,'same')}}));
 await assert.rejects(stuck.bots('111111'),e=>e.code==='API_PAGINATION');
});
test('calls use cursor/date variables and report scanned versus usable counts',async()=>{
 let vars;const api=new CliGraphql({cliConfigFile:file},async(_,o)=>{vars=JSON.parse(o.body).variables;return wrap({activities:{pageInfo:info(true,'next'),nodes:[call(),call({direction:'OUTBOUND'}),call({transcription:null,summary:null})]}});});
 const r=await api.calls('111111',{after:'prior',perPage:50,since:'2026-10-01',until:'2026-10-02'});
 assert.deepEqual(vars,{account:'111111',first:50,after:'prior',startAt:'2026-10-01T00:00:00.000Z',endAt:'2026-10-02T23:59:59.999Z'});
 assert.equal(r.returned,3);assert.equal(r.matching_direction,2);assert.equal(r.with_transcript,1);assert.equal(r.calls.length,1);assert.equal(r.next_cursor,'next');assert.equal(r.total,null);
});
test('empty transcript page preserves pagination; unfiltered mode retains missing text honestly',async()=>{
 const api=new CliGraphql({cliConfigFile:file},async()=>wrap({activities:{pageInfo:info(true,'next'),nodes:[call({transcription:null})]}}));
 const empty=await api.calls('111111');assert.equal(empty.calls.length,0);assert.equal(empty.has_more,true);
 const all=await api.calls('111111',{hasTranscription:false});assert.equal(all.calls.length,1);assert.equal(all.with_transcript,0);
 await assert.rejects(api.calls('111111',{after:'next'}),e=>e.code==='API_PAGINATION');
});
test('invalid dates/accounts fail before network and GraphQL errors discard partial data',async()=>{
 let n=0;const api=new CliGraphql({cliConfigFile:file},async()=>{n++;return new Response(JSON.stringify({data:{account:{legacyId:'111111'}},errors:[{message:'fixture-secret-private-data'}]}));});
 for(const opts of [{since:'2026-02-30'},{since:'tomorrow'},{since:'2026-10-03',until:'2026-10-01'}])await assert.rejects(api.calls('111111',opts));
 await assert.rejects(api.bots('111111) { viewer { id } }'));assert.equal(n,0);
 await assert.rejects(api.bots('111111'),e=>e.code==='GRAPHQL_ERROR'&&!e.message.includes('fixture-secret'));
});
test('401, network failure, malformed response, and unavailable account are safe',async()=>{
 for(const [reply,code] of [[()=>new Response('fixture-secret',{status:401}),'CLI_LOGIN_REQUIRED'],[()=>{throw Error('fixture-secret')},'API_NETWORK'],[()=>new Response('fixture-secret'),'API_RESPONSE'],[()=>new Response(JSON.stringify({data:{account:null}})),'FORBIDDEN']]){
  const api=new CliGraphql({cliConfigFile:file},async()=>reply());await assert.rejects(api.bots('111111'),e=>e.code===code&&!e.message.includes('fixture-secret'));
 }
});

test('stdio CLI mode gives terminal login instructions, preserves CLI config, and rejects expired reads',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const {readFile}=await import('node:fs/promises');
 await save({...session(),graphql_token_expires_at:'2000-01-01T00:00:00Z'});const before=await readFile(file,'utf8');
 const client=new Client({name:'cli-stdio-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/index.js',import.meta.url).pathname],env:{...process.env,CTM_VOICEAI_AUTH_MODE:'cli',CTM_VOICEAI_CLI_CONFIG:file,XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,CTM_VOICEAI_ENV_FILE:join(root,'absent.env'),CTM_VOICEAI_OPEN_BROWSER:'0'},stderr:'pipe'});
 try {
  await client.connect(transport);
  const invoke=async(name,args={})=>{const r=await client.callTool({name:'ctm_voiceai_'+name,arguments:args});return {error:r.isError,value:JSON.parse(r.content[0].text)};};
  assert.equal((await invoke('configured')).value.auth_mode,'cli');
  assert.equal((await invoke('auth_status')).value.logged_in,false);
  assert.equal((await invoke('auth_login')).value.status,'external_login_required');
  assert.equal((await invoke('auth_logout')).value.code,'CLI_AUTH_EXTERNAL');
  assert.equal((await invoke('get_voice_bots',{account_id:'111111'})).value.code,'CLI_LOGIN_REQUIRED');
  assert.equal((await invoke('get_calls',{account_id:'111111',page:2})).value.code,'CURSOR_REQUIRED');
  assert.equal(await readFile(file,'utf8'),before);
 } finally {await client.close();}
});

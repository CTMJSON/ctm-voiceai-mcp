import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from '../dist/hosted/postgres.js';
import { Sealer } from '../dist/hosted/crypto.js';
import { ownerKey } from '../dist/hosted/identity.js';
import { artifacts, credential } from './hosted-fixtures.mjs';

const url=process.env.TEST_ADMIN_DATABASE_URL;
if(process.env.CI && !url) throw new Error('CI requires TEST_ADMIN_DATABASE_URL; PostgreSQL isolation tests may not be skipped.');
test('PostgreSQL: real RLS, encrypted persistence, owner-scoped idempotency and refresh locking',{skip:!url},async t=>{
  const admin=new Pool({connectionString:url,max:2});
  t.after(()=>admin.end());
  const password=randomBytes(24).toString('hex');
  // Only an ephemeral test database is supported. Do not point this suite at a deployed database.
  if(!new URL(url).pathname.endsWith('/voiceai_test'))throw Error('Test database must be named voiceai_test');
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='voiceai_app') THEN CREATE ROLE voiceai_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$");
  // Value is freshly generated hex, never input from a caller.
  await admin.query(`ALTER ROLE voiceai_app PASSWORD '${password}'`);
  await admin.query(await readFile(new URL('../deploy/schema.sql',import.meta.url),'utf8'));
  const appUrl=new URL(url);appUrl.username='voiceai_app';appUrl.password=password;
  const pool=new Pool({connectionString:appUrl.href,max:2});t.after(()=>pool.end());
  const key=randomBytes(32).toString('base64');const store=new PostgresStore(pool,new Sealer(key));
  await store.validateRole();
  await assert.rejects(new PostgresStore(admin,new Sealer(key)).validateRole());
  const a=ownerKey('https://fixture.example',randomUUID()),b=ownerKey('https://fixture.example',randomUUID());
  await store.credentials(a,async(_,save)=>save(credential('alice')));
  await store.credentials(b,async(_,save)=>save(credential('bob')));
  const raw=await admin.query('SELECT ciphertext FROM voiceai_credentials WHERE owner=$1',[a]);
  assert.ok(!raw.rows[0].ciphertext.includes('fixture-ctm'));assert.equal((await store.credentials(b,async v=>v)).accessToken,'fixture-ctm-access-bob');
  const report={id:randomUUID(),accountId:artifacts.account_id,artifacts,createdAt:Date.now(),expiresAt:Date.now()+60000};const idem=randomUUID();
  const writes=await Promise.all([store.saveReport(a,report,idem),store.saveReport(a,{...report,id:randomUUID()},idem)]);
  assert.equal(writes[0].id,writes[1].id);
  const persisted=new PostgresStore(pool,new Sealer(key));
  assert.deepEqual((await persisted.getReport(a,writes[0].id)).artifacts,artifacts);
  assert.equal(await persisted.getReport(b,writes[0].id),null);
  assert.equal((await persisted.listReports(b,50)).length,0);
  await assert.rejects(store.saveReport(a,{...report,id:randomUUID(),artifacts:{...artifacts,call_count:99}},idem),e=>e.code==='CONFLICT');
  await store.saveReport(b,{...report,id:randomUUID()},idem);assert.equal((await store.listReports(b,50)).length,1);
  const connection=await pool.connect();
  try {
    await connection.query('BEGIN');await connection.query("SELECT set_config('voiceai.owner',$1,true)",[b]);
    // Omit the application's WHERE-owner filter entirely: RLS still hides other users.
    assert.equal((await connection.query('SELECT * FROM voiceai_credentials WHERE owner=$1',[a])).rows.length,0);
    assert.equal((await connection.query('SELECT * FROM voiceai_reports WHERE id=$1',[writes[0].id])).rows.length,0);
    await assert.rejects(connection.query('UPDATE voiceai_credentials SET owner=$1 WHERE owner=$2',[a,b]),e=>e.code==='42501');
    await connection.query('ROLLBACK');
    assert.equal((await connection.query('SELECT * FROM voiceai_credentials')).rows.length,0,'SET LOCAL must not leak on pooled connection reuse');
  } finally { connection.release(); }
  // Copying ciphertext to another user is blocked by authenticated encryption even with admin access.
  const originalB=(await admin.query('SELECT ciphertext FROM voiceai_credentials WHERE owner=$1',[b])).rows[0].ciphertext;
  await admin.query('UPDATE voiceai_credentials SET ciphertext=$1 WHERE owner=$2',[raw.rows[0].ciphertext,b]);
  await assert.rejects(store.credentials(b,async v=>v),e=>e.code==='STORAGE_ERROR');
  await admin.query('UPDATE voiceai_credentials SET ciphertext=$1 WHERE owner=$2',[originalB,b]);
  let refreshes=0;await store.credentials(a,async(_,save)=>save(credential('alice',{expiresAt:1})));
  const refresh=()=>persisted.credentials(a,async(v,save)=>{if(v.expiresAt===1){refreshes++;await new Promise(r=>setTimeout(r,20));await save({...v,expiresAt:Date.now()+60000});}});
  await Promise.all([refresh(),refresh(),refresh()]);assert.equal(refreshes,1);
  const session=randomUUID();await store.putSession(session,{kind:'fixture'},Date.now()+60000);
  const consumed=await Promise.all([store.getSession(session,true),store.getSession(session,true)]);assert.equal(consumed.filter(Boolean).length,1);
  // Insert expired row as admin to model an existing row passing its retention deadline.
  await admin.query('UPDATE voiceai_reports SET expires_at=now()-interval \'1 second\' WHERE owner=$1',[a]);
  assert.equal(await store.getReport(a,writes[0].id),null);assert.equal((await store.listReports(a,50)).length,0);
});

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../dist/errors.js';
import { Sealer } from '../dist/hosted/crypto.js';

// Test double only. Production always requires PostgreSQL and forced RLS.
export class MemoryStore {
  credentialsData = new Map(); sessions = new Map(); reports = new Map(); keys = new Map(); locks = new Map();
  sealer = new Sealer(randomBytes(32).toString('base64'));
  async credentials(owner, work) {
    const previous = this.locks.get(owner) ?? Promise.resolve();
    let release; const lock = new Promise(r => release = r); this.locks.set(owner, lock);
    await previous;
    try {
      let value = this.credentialsData.has(owner) ? this.sealer.open(this.credentialsData.get(owner),owner) : null;
      const result = await work(value, async next => { value = next; });
      if (value) this.credentialsData.set(owner,this.sealer.seal(value,owner)); else this.credentialsData.delete(owner);
      return result;
    } finally { release(); if(this.locks.get(owner)===lock) this.locks.delete(owner); }
  }
  async putSession(id,value,expiresAt) { if(this.sessions.has(id)) throw Error('duplicate'); this.sessions.set(id,{value:structuredClone(value),expiresAt}); }
  async getSession(id,consume=false) { const row=this.sessions.get(id); if(!row || row.expiresAt<=Date.now()) return null; if(consume)this.sessions.delete(id); return structuredClone(row.value); }
  async deleteSession(id) { this.sessions.delete(id); }
  async saveReport(owner,report,key) {
    const mapKey=JSON.stringify([owner,key]), prior=this.keys.get(mapKey);
    const digest=createHash('sha256').update(JSON.stringify(report.artifacts)).digest('hex');
    if(prior) { if(prior.digest!==digest) throw new AppError('Conflict','CONFLICT',409); return structuredClone(prior.summary); }
    const {artifacts,...summary}=report;
    this.reports.set(JSON.stringify([owner,report.id]),structuredClone(report)); this.keys.set(mapKey,{digest,summary});
    return summary;
  }
  async getReport(owner,id) { const r=this.reports.get(JSON.stringify([owner,id])); return r && r.expiresAt>Date.now() ? structuredClone(r):null; }
  async listReports(owner,limit) { return [...this.reports.entries()].filter(([key,r])=>JSON.parse(key)[0]===owner && r.expiresAt>Date.now()).slice(0,limit).map(([,r])=>{const {artifacts,...s}=r;return structuredClone(s);}); }
}
export const credential = (suffix,extra={}) => ({ accessToken:`fixture-ctm-access-${suffix}`,refreshToken:`fixture-ctm-refresh-${suffix}`,expiresAt:Date.now()+3600000,clientId:'fixture-client',scopes:'profile activity reports manage',accountId:null,...extra });
export const artifacts = { account_id:'123456',call_count:1,topics:[{name:'Scheduling',call_count:1}],call_rows:[],bots:[],recommendations:[],rewrites:[],generated_instructions:'' };

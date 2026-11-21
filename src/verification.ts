import { z } from 'zod';
import { db, event, getCandidate, getKV, getProduct, now, saveCandidate, saveProduct, setKV, settings, transaction, uid } from './db.js';
import { assessCandidate, verificationKey, VISUAL_POLICY_VERSION } from './matcher.js';
import { checkNames, readCodexStatus, runCodexVisual, type CodexRun, type CodexStatus, type VisualResult } from './codex-client.js';
import { localOCR, ocrResult } from './ocr.js';
import { localFile, sha } from './images.js';
import { readFile } from 'node:fs/promises';
import type { Candidate, Product } from './types.js';
import { selected,removeSelection } from './gallery.js';
import {reassessProduct} from './confidence.js';
db.exec(`CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY,cache_key TEXT NOT NULL UNIQUE,candidate_id TEXT NOT NULL,code TEXT NOT NULL,engine TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS verification_code ON verifications(code);
CREATE TABLE IF NOT EXISTS visual_jobs (id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,cache_key TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS visual_active ON visual_jobs(cache_key) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE IF NOT EXISTS codex_runs (id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visual_lock (id INTEGER PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`);
export const visualSettingsSchema=z.object({enabled:z.boolean(),batchSize:z.number().int().min(1).max(3),maxCandidatesPerDay:z.number().int().min(1).max(50),maxTokensPerDay:z.number().int().min(1000).max(1000000),pauseAtPercent:z.number().min(50).max(98),fallbackOCR:z.boolean()});
export const visualSettings=()=>getKV('visualSettings',{enabled:false,batchSize:2,maxCandidatesPerDay:50,maxTokensPerDay:150000,pauseAtPercent:95,fallbackOCR:true});
export function usageToday(){const rows=db.prepare('SELECT body FROM codex_runs WHERE created_at>=?').all(now().slice(0,10)) as {body:string}[];return rows.map(r=>JSON.parse(r.body)).reduce((a,r)=>({candidates:a.candidates+(r.count||0),inputTokens:a.inputTokens+(r.usage?.input_tokens||0),outputTokens:a.outputTokens+(r.usage?.output_tokens||0),cachedTokens:a.cachedTokens+(r.usage?.cached_input_tokens||0),runs:a.runs+1}),{candidates:0,inputTokens:0,outputTokens:0,cachedTokens:0,runs:0});}
export function quotaReason(status:CodexStatus) {
  const cfg=visualSettings(),usage=usageToday();
  if(!cfg.enabled)return 'Codex visual review disabled';
  if(!status.available)return status.error||'Codex unavailable';
  if(status.authMode!=='chatgpt')return 'Saved ChatGPT authentication required; API keys are not permitted';
  if(status.limitReached||status.windows.some(w=>w.usedPercent>=cfg.pauseAtPercent))return 'Codex quota threshold reached';
  if(usage.candidates>=cfg.maxCandidatesPerDay)return 'Daily candidate review limit reached';
  if(usage.inputTokens+usage.outputTokens>=cfg.maxTokensPerDay)return 'Daily token budget reached';
  return '';
}
export async function refreshCodexStatus(){const status=await readCodexStatus();setKV('codexStatus',status);return status;}
export function enqueueVisual(candidateIds?:string[],pilotOnly=true,upgradeFallback=false) {
  const all=(db.prepare('SELECT body FROM candidates').all() as {body:string}[]).map(r=>JSON.parse(r.body) as Candidate);
  const allowed=all.filter(c=>c.decision!=='REJECTED'&&(!candidateIds||candidateIds.includes(c.id))&&(!pilotOnly||db.prepare("SELECT 1 FROM origins WHERE code=? AND sheet='Pilot 50'").get(c.code))).slice(0,50);
  let queued=0,cached=0;const pilotRows=Number((db.prepare("SELECT count(DISTINCT code) n FROM origins WHERE sheet='Pilot 50'").get() as {n:number}).n);
  transaction(()=>{
    for(const c of allowed){const p=getProduct(c.code)!,key=verificationKey(p,c),hit=db.prepare('SELECT body FROM verifications WHERE cache_key=?').get(key) as {body:string}|undefined;
      if(hit&&!(upgradeFallback&&JSON.parse(hit.body).engine!=='CODEX_CLI')){applyVerification(c,p,JSON.parse(hit.body));cached++;continue;}
      const r=db.prepare("INSERT OR IGNORE INTO visual_jobs(id,candidate_id,cache_key,status,created_at) VALUES (?,?,?,'QUEUED',?)").run(uid(),c.id,key,now());queued+=Number(r.changes);
    }
    event('','VISUAL_QUEUE',`${queued} candidates queued, ${cached} cached results reused`,{pilotOnly,policy:VISUAL_POLICY_VERSION});
  });
  return {queued,cached,pilotProducts:pilotRows,shortlisted:allowed.length,note:allowed.length?'Maximum 50 candidates per request; 1–3 per Codex call.':'No shortlisted images. Import/photo or extract candidates first; no images are fabricated.'};
}
function applyVerification(c:Candidate,p:Product,result:NonNullable<Candidate['visual']>) {
  if(result.fingerprint!==verificationKey(p,c))return;
  c.visual=result;if(result.view){c.view=result.view.kind;c.viewVerified=result.engine==='CODEX_CLI'&&result.view.kind!=='UNKNOWN';}c.assessment=assessCandidate(p,c,settings());
  // Visual results never silently approve a candidate. A new uncertainty also revokes stale ready state.
  if(selected(p,c.id)&&(c.assessment.category!=='HIGH'||selected(p,c.id)!.view!==c.view)){
    c.decision='PENDING';c.quality='PENDING';removeSelection(p,c.id);p.quality='PENDING';p.workflow='AWAITING_REVIEW';p.rights='UNVERIFIED';
  }
  if(!p.approvedCandidate){p.matching=c.assessment.category;p.workflow='AWAITING_REVIEW';}
  saveCandidate(c);saveProduct(p);
}
const state=z.enum(['MATCH','MISMATCH','UNCERTAIN','NOT_VISIBLE']);
const qualityState=z.enum(['YES','NO','UNCERTAIN']);
const imageQualitySchema=z.object({fullProductVisible:qualityState,textLegible:qualityState,watermark:qualityState,screenshot:qualityState,importantLabelsCropped:qualityState,artifacts:qualityState,reason:z.string().max(3000)});
export const resultSchema=z.object({candidateId:z.string().uuid(),verdict:z.enum(['EXACT_MATCH','MISMATCH','UNCERTAIN']),checks:z.object(Object.fromEntries(checkNames.map(n=>[n,z.object({state,reason:z.string().max(3000)})])) as Record<typeof checkNames[number],z.ZodObject<{state:typeof state;reason:z.ZodString}>>),visibleText:z.string().max(20000),visibleBarcode:z.string().max(40),differences:z.array(z.string().max(3000)).max(30),reasons:z.array(z.string().max(3000)).max(30),view:z.object({kind:z.enum(['FRONT','BACK','NUTRITION','FSSAI','OTHER','UNKNOWN']),reason:z.string().max(3000),detailsAvailable:z.array(z.string().max(200)).max(12)}).optional(),imageQuality:imageQualitySchema.optional()});
export function saveVerification(c:Candidate,p:Product,result:VisualResult,engine:NonNullable<Candidate['visual']>['engine'],fallbackReason='') {
  const verified=resultSchema.parse(result);const key=verificationKey(p,c),id=uid();
  if(result.imageQuality)verified.imageQuality=result.imageQuality;
  const summary:NonNullable<Candidate['visual']>={...verified,id,fingerprint:key,engine,createdAt:now(),fallbackReason};
  transaction(()=>{db.prepare('INSERT INTO verifications VALUES (?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET engine=excluded.engine,body=excluded.body,created_at=excluded.created_at').run(id,key,c.id,c.code,engine,JSON.stringify(summary),now());applyVerification(c,p,summary);event(c.code,'VISUAL_RESULT',`${engine}: ${verified.verdict}`,{id,category:c.assessment.category,checks:verified.checks,fallbackReason});});reassessProduct(c.code);return summary;
}
export async function processVisualBatch(jobs:{id:string;candidate_id:string;cache_key:string}[],deps:{status?:()=>Promise<CodexStatus>;review?:typeof runCodexVisual;ocr?:typeof localOCR}={}) {
  const cfg=visualSettings();const entries:{job:typeof jobs[number];c:Candidate;p:Product}[]=[];
  for(const job of jobs){const c=getCandidate(job.candidate_id),p=c&&getProduct(c.code);if(!c||!p){db.prepare("UPDATE visual_jobs SET status='FAILED',error='Candidate missing' WHERE id=?").run(job.id);continue;}
    if(verificationKey(p,c)!==job.cache_key){db.prepare("UPDATE visual_jobs SET status='STALE',error='Product or candidate changed' WHERE id=?").run(job.id);continue;}
    if(sha(await readFile(localFile(c.originalFile)))!==c.hash){db.prepare("UPDATE visual_jobs SET status='FAILED',error='Original checksum changed' WHERE id=?").run(job.id);continue;}
    entries.push({job,c,p});
  }
  if(!entries.length)return;
  let status=getKV<CodexStatus|null>('codexStatus',null),reason=getKV('visualCodexPaused','');
  if(!reason){status=await (deps.status||refreshCodexStatus)();reason=quotaReason(status);}
  const usage=usageToday();if(!reason&&usage.candidates+entries.length>cfg.maxCandidatesPerDay)reason='Daily candidate limit would be exceeded';
  let run:CodexRun|undefined;
  if(!reason){
    // Record attempts before launching, so retries/timeouts also count against the local budget.
    const runId=uid();db.prepare('INSERT INTO codex_runs VALUES (?,?,?)').run(runId,JSON.stringify({count:entries.length,status:'STARTED',usage:{},policy:VISUAL_POLICY_VERSION}),now());
    try{run=await (deps.review||runCodexVisual)(entries.map(({c,p})=>({candidateId:c.id,imagePath:localFile(c.originalFile),catalog:{code:p.code,name:p.name,brand:p.brand,productName:p.productName,size:p.size,barcodes:p.barcodes,conflict:p.conflict,ownBrand:p.ownBrand},sourceEvidence:c.evidence})));
      const results=run.results.map(r=>resultSchema.parse(r));if(results.length!==entries.length||new Set(results.map(r=>r.candidateId)).size!==entries.length||results.some(r=>!entries.some(e=>e.c.id===r.candidateId)))throw new Error('Codex returned incomplete/duplicate/unknown candidate IDs');
      db.prepare('UPDATE codex_runs SET body=? WHERE id=?').run(JSON.stringify({count:entries.length,status:'COMPLETE',usage:run.usage,model:run.model,policy:VISUAL_POLICY_VERSION}),runId);
    }catch(e){reason=`Codex unavailable or limited: ${(e as Error).message.slice(-900)}`;db.prepare('UPDATE codex_runs SET body=? WHERE id=?').run(JSON.stringify({count:entries.length,status:'FAILED',usage:run?.usage||{},error:reason}),runId);run=undefined;}
    // Refresh quotas after a successful call; errors never trigger automatic retries or credit purchases.
    if(run&&!deps.status)await refreshCodexStatus();
  }
  if(reason){setKV('visualCodexPaused',reason);event('','CODEX_PAUSED',reason);}
  for(const entry of entries){const {job}=entry;const c=getCandidate(entry.c.id)!,p=getProduct(entry.p.code)!;
    if(verificationKey(p,c)!==job.cache_key){db.prepare("UPDATE visual_jobs SET status='STALE',error='Record changed during review' WHERE id=?").run(job.id);continue;}
    try {
      if(run){const result=run.results.find(r=>r.candidateId===c.id)!;saveVerification(c,p,result,'CODEX_CLI');db.prepare("UPDATE visual_jobs SET status='DONE',error='' WHERE id=?").run(job.id);}
      else {
        let text='',ocrError='';if(cfg.fallbackOCR)try{text=await (deps.ocr||localOCR)(localFile(c.originalFile));}catch(e){ocrError=(e as Error).message.slice(-500);}
        const result=ocrResult(p,c,text);if(ocrError)result.reasons.push(ocrError);
        saveVerification(c,p,result,text?'LOCAL_OCR':'MANUAL_REQUIRED',reason);db.prepare("UPDATE visual_jobs SET status='FALLBACK',error=? WHERE id=?").run(reason,job.id);
      }
    }catch(e){db.prepare("UPDATE visual_jobs SET status='FAILED',error=? WHERE id=?").run(String(e),job.id);event(p.code,'VISUAL_ERROR',String(e));}
  }
}
export function visualDashboard(){return {settings:visualSettings(),status:getKV('codexStatus',null),pausedReason:getKV('visualCodexPaused',''),usage:usageToday(),jobs:db.prepare('SELECT * FROM visual_jobs ORDER BY created_at DESC LIMIT 100').all(),results:db.prepare('SELECT code,engine,body,created_at FROM verifications ORDER BY created_at DESC LIMIT 100').all(),pilot:{products:(db.prepare("SELECT count(DISTINCT code) n FROM origins WHERE sheet='Pilot 50'").get() as {n:number}).n,candidates:(db.prepare("SELECT count(*) n FROM candidates c WHERE EXISTS (SELECT 1 FROM origins o WHERE c.code=o.code AND o.sheet='Pilot 50')").get() as {n:number}).n}};}

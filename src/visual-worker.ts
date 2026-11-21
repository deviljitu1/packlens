import { db, event, getKV, now, setKV, transaction, uid } from './db.js';
import { processVisualBatch, visualSettings } from './verification.js';
import { setTimeout as sleep } from 'node:timers/promises';
const owner=uid();let quitting=false;process.on('SIGINT',()=>{quitting=true;});process.on('SIGTERM',()=>{quitting=true;});
const lock=db.prepare('INSERT INTO visual_lock VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE visual_lock.expires<? RETURNING owner').get(owner,Date.now()+20000,Date.now()) as {owner:string}|undefined;
if(lock?.owner!==owner){console.error('Visual worker already running');process.exit(1);}
db.prepare("UPDATE visual_jobs SET status='QUEUED' WHERE status='RUNNING'").run();
const beat=setInterval(()=>{db.prepare('UPDATE visual_lock SET expires=? WHERE owner=?').run(Date.now()+20000,owner);setKV('visualWorkerHeartbeat',{at:now(),pid:process.pid});},3000);
console.log('PackLens visual worker running. ChatGPT-authenticated Codex CLI; no API-key integration.');
try{while(!quitting){if(getKV('visualQueuePaused',false)){await sleep(500);continue;}const jobs=transaction(()=>{
  const rows=db.prepare("SELECT * FROM visual_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT ?").all(visualSettings().batchSize) as {id:string;candidate_id:string;cache_key:string}[];
  for(const row of rows)db.prepare("UPDATE visual_jobs SET status='RUNNING',attempts=attempts+1 WHERE id=?").run(row.id);return rows;
});if(!jobs.length){await sleep(500);continue;}try{await processVisualBatch(jobs);}catch(e){for(const job of jobs)db.prepare("UPDATE visual_jobs SET status='FAILED',error=? WHERE id=?").run(String(e),job.id);event('','VISUAL_WORKER_ERROR',String(e));}}}finally{clearInterval(beat);db.prepare('DELETE FROM visual_lock WHERE owner=?').run(owner);db.close();}

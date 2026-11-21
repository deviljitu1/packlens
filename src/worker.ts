import { setTimeout as sleep } from 'node:timers/promises';
import { db, candidates, event, getKV, getProduct, now, saveProduct, saveSource, setKV, settings, sources, transaction, uid } from './db.js';
import { adapterFor, assertSource, failSource, saveLead } from './sources.js';
import { approve, cleared } from './images.js';
import { enqueueVisual } from './verification.js';
import { enqueue } from './queue.js';
import { browserFallback } from './discovery.js';
const owner=uid();let quitting=false;
process.on('SIGINT',()=>{quitting=true;});process.on('SIGTERM',()=>{quitting=true;});
const lock=db.prepare('INSERT INTO worker_lock VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE worker_lock.expires < ? RETURNING owner').get(owner,Date.now()+20000,Date.now()) as {owner:string}|undefined;
if(!lock||lock.owner!==owner){console.error('A worker is already running.');process.exit(1);}
const heartbeat=setInterval(()=>{
  db.prepare('UPDATE worker_lock SET expires=? WHERE owner=?').run(Date.now()+20000,owner);
  db.prepare("UPDATE tasks SET lease_until=? WHERE status='RUNNING'").run(Date.now()+30000);
  setKV('workerHeartbeat',{at:now(),pid:process.pid});
},3000);
event('','WORKER_START','Worker started',{pid:process.pid});
// Exclusive worker lock proves previous owner expired. Recover tasks immediately without duplicate claims.
transaction(()=>{
  const interrupted=db.prepare("SELECT code FROM tasks WHERE status='RUNNING'").all() as {code:string}[];
  db.prepare("UPDATE tasks SET status='QUEUED',lease_until=0 WHERE status='RUNNING'").run();
  for(const {code} of interrupted){const p=getProduct(code);if(p&&!p.approvedCandidate){p.workflow='QUEUED';saveProduct(p);}event(code,'RECOVERED','Interrupted job returned to queue');}
  for(const row of db.prepare("SELECT body FROM products WHERE workflow='ENHANCING'").all() as {body:string}[]){const p=JSON.parse(row.body);p.workflow='APPROVED';saveProduct(p);event(p.code,'RECOVERED','Interrupted enhancement may be safely repeated');}
});
console.log('PackLens worker running. Database-backed queue; concurrency 1.');
try {
  while(!quitting) {
    if(getKV('queuePaused',false)){await sleep(500);continue;}
    const due=db.prepare('SELECT code FROM source_retries WHERE due_at<=? AND attempts<=2 LIMIT 1').get(Date.now()) as {code:string}|undefined;
    if(due){enqueue([due.code],true);db.prepare('UPDATE source_retries SET due_at=? WHERE code=?').run(Date.now()+24*60*60*1000,due.code);}
    const task=transaction(()=>db.prepare("UPDATE tasks SET status='RUNNING',attempts=attempts+1,lease_until=? WHERE id=(SELECT id FROM tasks WHERE status='QUEUED' ORDER BY created_at LIMIT 1) RETURNING id,code").get(Date.now()+30000)) as {id:string;code:string}|undefined;
    if(!task){await sleep(500);continue;}
    const p=getProduct(task.code)!,replacement=db.prepare("SELECT id FROM replacement_requests WHERE code=? AND status IN ('QUEUED','SEARCHING','WAITING_SOURCE') ORDER BY created_at LIMIT 1").get(task.code) as {id:string}|undefined;
    if(p.ownBrand||p.approvedCandidate&&!replacement){db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(task.id);continue;}
    if(replacement)db.prepare("UPDATE replacement_requests SET status='SEARCHING',attempts=attempts+1 WHERE id=?").run(replacement.id);
    p.workflow='SEARCHING';saveProduct(p);event(p.code,'SEARCH_START','Searching enabled, authorized sources');
    try {
      let found=0,blocked=false,tried=0,failures=0;const cached=replacement?[]:candidates(p.code).filter(c=>c.decision!=='REJECTED');
      if(cached.length){found=cached.length;event(p.code,'CACHE','Using previously saved candidates; reject them before asking for alternatives');}
      else for(const source of sources().filter(s=>s.enabled&&s.kind!=='manual')) {
        if(quitting||getKV('queuePaused',false))break;
        const cosmetic=/soap|shampoo|conditioner|toothpaste|toothbrush|cream|lotion|deodorant|perfume|lipstick|face wash|hand wash|hair oil|talc|sanitizer/i.test(p.name);
        if(source.id==='obf'&&!cosmetic||source.id==='opf'&&!/general merchandise/i.test(p.department))continue;
        if(source.blockedUntil>Date.now()){blocked=true;event(p.code,'SOURCE_PAUSED',`${source.name} paused until ${new Date(source.blockedUntil).toISOString()}`,{source:source.id,reason:source.health});continue;}
        try {
          assertSource(source);tried++;
          const delay=Math.max(source.kind==='off'?7000:1000,source.throttleMs)-(Date.now()-source.lastRequest);
          if(delay>0)await sleep(delay);
          if(quitting||getKV('queuePaused',false))break;
          source.lastRequest=Date.now();saveSource(source);
          const query=p.productName||p.suggestedSearch;
          const adapter=adapterFor(source), leads=await adapter.search(p,query);
          event(p.code,'SEARCH_RESULTS',`${leads.length} leads from ${source.name}`,{source:source.id,query});
          for(const lead of leads.slice(0,5)) {
            if(quitting)break;
            try {await saveLead(p.code,lead,source);found++;}catch(e){failSource(source,e);failures++;if(source.blockedUntil>Date.now()){blocked=true;break;}event(p.code,'IMAGE_FETCH_ERROR',String(e),{source:source.id});}
          }
          if(!source.health.includes('ERROR')&&source.blockedUntil<=Date.now()){source.health=`Last search returned ${leads.length} leads (${now()})`;saveSource(source);}
          if(candidates(p.code).some(c=>c.decision!=='REJECTED'&&!c.assessment.vetoes.length&&c.assessment.score>=settings().mediumThreshold))break;
        }catch(e){failures++;failSource(source,e);blocked ||= source.blockedUntil>Date.now();event(p.code,'SOURCE_FAILED',String(e),{source:source.id});}
      }
      if(!found&&getKV('browserFallbackEnabled',false)&&!quitting&&!getKV('queuePaused',false)){const fallback=await browserFallback(p);found+=fallback.saved;}
      const current=getProduct(p.code)!;
      if(!current.approvedCandidate){
        const list=candidates(p.code).filter(c=>c.decision!=='REJECTED');const rank={HIGH:3,MEDIUM:2,LOW:1,NOT_ASSESSED:0,NO_MATCH:0,SOURCE_BLOCKED:0};list.sort((a,b)=>rank[b.assessment.category]-rank[a.assessment.category]||b.assessment.score-a.assessment.score||b.width*b.height-a.width*a.height);
        current.matching=list[0]?.assessment.category||(blocked?'SOURCE_BLOCKED':'NO_MATCH');
        current.workflow=found?'AWAITING_REVIEW':blocked||failures?'FAILED':'NEEDS_STORE_PHOTO';saveProduct(current);
        const best=list[0];if(settings().autoApprove&&best?.assessment.category==='HIGH'&&cleared(best.rights)&&best.rightsEvidence&&best.rightsReviewer)approve(best.id,'Automatic HIGH rule','Packaging verified and commercial-use rights cleared');
        if(getKV('autoVisualReview',false)&&best&&!best.assessment.vetoes.length)enqueueVisual(list.filter(c=>!c.assessment.vetoes.length&&c.evidence.barcode===best.evidence.barcode&&c.pageUrl===best.pageUrl).slice(0,5).map(c=>c.id),false);
      }
      const interrupted=(quitting||getKV('queuePaused',false))&&!found;
      const failed=(blocked||tried>0&&failures>=tried)&&!found&&!interrupted;
      db.prepare('UPDATE tasks SET status=?,error=?,lease_until=0 WHERE id=?').run(interrupted?'QUEUED':failed?'FAILED':'DONE',failed?'All attempted sources failed; see item log':'',task.id);
      if(blocked&&!found&&!interrupted){const prior=db.prepare('SELECT attempts FROM source_retries WHERE code=?').get(p.code) as {attempts:number}|undefined;if(!prior||prior.attempts<2){const next=sources().filter(s=>s.enabled&&s.blockedUntil>Date.now()).map(s=>s.blockedUntil);if(next.length)db.prepare('INSERT INTO source_retries VALUES (?,?,1,?) ON CONFLICT(code) DO UPDATE SET due_at=excluded.due_at,attempts=source_retries.attempts+1,reason=excluded.reason').run(p.code,Math.min(...next),'Source unavailable; retry after recorded backoff');}else{db.prepare('UPDATE source_retries SET attempts=3,reason=? WHERE code=?').run('Automatic retry limit reached; exception preserved',p.code);event(p.code,'SOURCE_RETRY_EXHAUSTED','Two bounded automatic retries exhausted; exception retained');}}
      else if(found)db.prepare('DELETE FROM source_retries WHERE code=?').run(p.code);
      if(replacement&&!found)db.prepare("UPDATE replacement_requests SET status='WAITING_SOURCE' WHERE id=?").run(replacement.id);
      if(interrupted){const latest=getProduct(p.code)!;if(!latest.approvedCandidate){latest.workflow='QUEUED';saveProduct(latest);}}
      event(p.code,'SEARCH_END',`${found} candidates saved; ${tried} sources attempted`,{blocked,failures,interrupted});
    } catch(e) {db.prepare("UPDATE tasks SET status='FAILED',error=?,lease_until=0 WHERE id=?").run(String(e),task.id);const current=getProduct(p.code)!;if(!current.approvedCandidate){current.workflow='FAILED';saveProduct(current);}event(p.code,'JOB_FAILED',String(e));}
  }
} finally {clearInterval(heartbeat);db.prepare('DELETE FROM worker_lock WHERE owner=?').run(owner);event('','WORKER_STOP','Worker stopped');db.close();}

import { db, event, getKV, getProduct, now, saveProduct, setKV, transaction, uid } from './db.js';
export function enqueue(codes:string[],retry=false) {
  let count=0;transaction(()=>{
    for(const code of [...new Set(codes)]) {
      const p=getProduct(code),replacement=db.prepare("SELECT 1 FROM replacement_requests WHERE code=? AND status IN ('QUEUED','SEARCHING','WAITING_SOURCE')").get(code);if(!p||p.ownBrand||p.approvedCandidate&&!replacement)continue;
      if(!retry&&db.prepare("SELECT 1 FROM tasks WHERE code=? AND status='DONE'").get(code))continue;
      const result=db.prepare("INSERT OR IGNORE INTO tasks(id,code,status,created_at) VALUES (?,?,'QUEUED',?)").run(uid(),code,now());
      if(result.changes){count++;p.workflow='QUEUED';saveProduct(p);}
    }
    setKV('queuePaused',false);event('','QUEUE',`${count} products queued`,{retry});
  });return {queued:count};
}
export function queueControl(action:string) {
  transaction(()=>{
    if(action==='pause')setKV('queuePaused',true);
    else if(action==='resume')setKV('queuePaused',false);
    else if(action==='stop') {
      setKV('queuePaused',true);
      const rows=db.prepare("SELECT code FROM tasks WHERE status='QUEUED'").all() as {code:string}[];
      db.prepare("UPDATE tasks SET status='CANCELLED' WHERE status='QUEUED'").run();
      for(const {code} of rows){const p=getProduct(code)!;if(p.workflow==='QUEUED'){p.workflow='IMPORTED';saveProduct(p);}}
    } else throw new Error('Unknown queue control');
    event('','QUEUE_CONTROL',action);
  });return {paused:getKV('queuePaused',false),note:'In-flight source requests settle before pause/stop takes effect.'};
}

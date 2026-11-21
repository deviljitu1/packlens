import path from 'node:path';
import { access,copyFile,mkdir,readFile,rename,stat,unlink,writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { db,dataDir,event,getCandidate,getKV,getProduct,now,saveCandidate,saveProduct,setKV,settings,transaction,uid } from './db.js';
import { localFile,sha } from './images.js';
import { analyzeImage,visualQualityFailures } from './quality.js';
import { removeSelection,selected } from './gallery.js';
import { enqueue } from './queue.js';
import type { Candidate,ImageView } from './types.js';
import { localCapabilities,localImageTool } from './local-tools.js';
import {reassessProduct} from './confidence.js';
export const reviewRoot=path.join(dataDir,'Product Images');
const categories={HIGH:'High confidence',MEDIUM:'Medium confidence',LOW:'Low confidence'} as const;
db.exec(`CREATE TABLE IF NOT EXISTS review_files (candidate_id TEXT PRIMARY KEY,code TEXT NOT NULL,sequence INTEGER NOT NULL,view TEXT NOT NULL,category TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,missing_since INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(code,sequence));
CREATE TABLE IF NOT EXISTS image_rejections (code TEXT NOT NULL,hash TEXT NOT NULL,image_url TEXT NOT NULL,view TEXT NOT NULL,sequence INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(code,hash));
CREATE TABLE IF NOT EXISTS replacement_requests (id TEXT PRIMARY KEY,code TEXT NOT NULL,sequence INTEGER NOT NULL,view TEXT NOT NULL,old_candidate TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS replacement_active ON replacement_requests(code,sequence) WHERE status IN ('QUEUED','SEARCHING','WAITING_SOURCE');
CREATE TABLE IF NOT EXISTS review_sync_lock (id INTEGER PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`);
type Inventory={candidate_id:string;code:string;sequence:number;view:ImageView;category:keyof typeof categories;path:string;hash:string;state:string;missing_since:number;created_at:string};
function reviewPath(relative:string){const result=path.resolve(reviewRoot,relative);if(!result.startsWith(reviewRoot+path.sep))throw new Error('Review file is outside the review folder');return result;}
export async function initReviewFolders(){
  await mkdir(reviewRoot,{recursive:true});for(const name of Object.values(categories))await mkdir(path.join(reviewRoot,name),{recursive:true});
  const marker=path.join(reviewRoot,'.packlens-review-root.json');try{await access(marker);}catch{await writeFile(marker,JSON.stringify({id:uid(),createdAt:now(),purpose:'Local image review. These files are not commercial approval.'}),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});}
  await writeFile(path.join(reviewRoot,'READ FIRST.txt'),'DOWNLOAD ONLY: original image bytes and source formats are preserved. No background removal, crop, resize, sharpening, upscaling or conversion.\r\nReview folders contain image candidates, not commercially cleared uploads. Delete a disliked image to reject it; the running app searches a different image for the same item/view. Do not rename/move whole category folders.\r\nFiles use <item_code>_<sequence>.<original extension>. Front=1, back=2, remaining genuine views=3..5. Missing views are reported, never fabricated. Keeping an image does not grant commercial reuse rights.\r\n');
}
export function rejectedImage(code:string,hash:string){return !!db.prepare('SELECT 1 FROM image_rejections WHERE code=? AND hash=?').get(code,hash);}
export function rejectedUrls(code:string){return (db.prepare('SELECT image_url FROM image_rejections WHERE code=?').all(code) as {image_url:string}[]).map(r=>r.image_url).filter(Boolean);}
async function foldersIntact(){try{await access(path.join(reviewRoot,'.packlens-review-root.json'));for(const name of Object.values(categories)){const s=await stat(path.join(reviewRoot,name));if(!s.isDirectory())return false;}return true;}catch{return false;}}
function availableSlot(c:Candidate,rows:Inventory[]):number|undefined {
  const replacement=db.prepare("SELECT sequence,view FROM replacement_requests WHERE code=? AND status IN ('QUEUED','SEARCHING','WAITING_SOURCE') ORDER BY created_at LIMIT 1").get(c.code) as {sequence:number;view:ImageView}|undefined;
  if(replacement&&(replacement.view==='UNKNOWN'||replacement.view==='OTHER'||c.view===replacement.view))return replacement.sequence;
  const used=new Set(rows.filter(r=>r.state!=='DELETED').map(r=>r.sequence));
  if(c.view==='FRONT')return used.has(1)?undefined:1;
  if(c.view==='BACK')return used.has(2)?undefined:2;
  return [3,4,5].find(slot=>!used.has(slot));
}
async function renderReview(c:Candidate){
  let source:Buffer=await readFile(localFile(c.originalFile));if(sha(source)!==c.hash)throw new Error('Original checksum changed');
  const analysis=c.qualityAnalysis||await analyzeImage(source),failures=[...analysis.failures,...visualQualityFailures(c)];if(failures.length)throw new Error('Image below quality floor: '+failures.join('; '));
  if(settings().downloadOnly)return source;
  const cfg=settings();if(cfg.removeBackground&&localCapabilities().backgroundRemoval)source=await localImageTool('background',source);
  const subject=await sharp(source).rotate().resize(cfg.width-cfg.margin*2,cfg.height-cfg.margin*2,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
  return sharp({create:{width:cfg.width,height:cfg.height,channels:4,background:cfg.background}}).composite([{input:subject,gravity:'centre'}]).flatten({background:cfg.background}).webp({quality:cfg.quality}).toBuffer();
}
async function detectDeletions(){
  if(!await foldersIntact())return {paused:'Review folder or marker unavailable; deletion detection paused to protect records',deleted:0};
  let deleted=0;
  const cursor=getKV('reviewScanCursor',0);const batch=db.prepare("SELECT rowid inventory_rowid,* FROM review_files WHERE state IN ('PRESENT','MISSING') AND rowid>? ORDER BY rowid LIMIT 1000").all(cursor) as (Inventory&{inventory_rowid:number})[];
  setKV('reviewScanCursor',batch.length?batch.at(-1)!.inventory_rowid:0);
  for(const row of batch){
    try{const bytes=await readFile(reviewPath(row.path));if(sha(bytes)!==row.hash){db.prepare("UPDATE review_files SET state='MODIFIED',missing_since=0 WHERE candidate_id=?").run(row.candidate_id);event(row.code,'REVIEW_MODIFIED','User edited review image; preserved without overwrite',{file:row.path});}else if(row.state==='MISSING')db.prepare("UPDATE review_files SET state='PRESENT',missing_since=0 WHERE candidate_id=?").run(row.candidate_id);}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')continue;if(!row.missing_since){db.prepare("UPDATE review_files SET state='MISSING',missing_since=? WHERE candidate_id=?").run(Date.now(),row.candidate_id);continue;}if(Date.now()-row.missing_since<2500)continue;
      transaction(()=>{const c=getCandidate(row.candidate_id),p=getProduct(row.code);if(!c||!p)return;c.decision='REJECTED';c.reviewedBy='Filesystem review';c.reviewReason=`User deleted ${row.path}`;saveCandidate(c);if(selected(p,c.id))removeSelection(p,c.id);p.workflow='AWAITING_REVIEW';p.quality='PENDING';saveProduct(p);db.prepare("UPDATE review_files SET state='DELETED' WHERE candidate_id=?").run(c.id);db.prepare('INSERT OR IGNORE INTO image_rejections VALUES (?,?,?,?,?,?,?)').run(c.code,c.hash,c.imageUrl,row.view,row.sequence,c.reviewReason,now());db.prepare("INSERT OR IGNORE INTO replacement_requests(id,code,sequence,view,old_candidate,status,created_at) VALUES (?,?,?,?,?,'QUEUED',?)").run(uid(),c.code,row.sequence,row.view,c.id,now());event(c.code,'REVIEW_DELETED','Deleted review image rejected; replacement search queued',{candidate:c.id,file:row.path,sequence:row.sequence,view:row.view});});
      reassessProduct(row.code);const paused=getKV('queuePaused',false);enqueue([row.code],true);if(paused)setKV('queuePaused',true);deleted++;
    }
  }
  return {deleted,paused:''};
}
export async function syncReviewFolders(){
  const owner=uid();const acquired=db.prepare('INSERT INTO review_sync_lock VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE review_sync_lock.expires<? RETURNING owner').get(owner,Date.now()+30000,Date.now()) as {owner:string}|undefined;if(acquired?.owner!==owner)return {busy:true,written:0,deleted:0,paused:''};
  const heartbeat=setInterval(()=>db.prepare('UPDATE review_sync_lock SET expires=? WHERE owner=?').run(Date.now()+30000,owner),3000);
  try{
    const deletion=await detectDeletions();if(deletion.paused){setKV('reviewFolderHealth',deletion.paused);return {...deletion,written:0};}
    if(settings().downloadOnly)await writeFile(path.join(reviewRoot,'READ FIRST.txt'),'DOWNLOAD ONLY: originals are preserved byte-for-byte, with their source format and resolution. No background removal, crop, resize, sharpening, denoise, upscale or conversion.\r\nDelete disliked images to reject them and queue different replacements for the same product/view. Original files remain in the separate originals archive.\r\nFilename: <item_code>_<sequence>.<original extension>. Full front=1; full back=2; genuine detail/other views=3..5. Missing views are reported. Keeping a review file is not commercial approval or image-rights clearance.\r\n');
    let written=0,held=0;
    for(const row of db.prepare('SELECT body FROM candidates ORDER BY rowid').all() as {body:string}[]){const c:Candidate=JSON.parse(row.body);if(c.decision==='REJECTED'||rejectedImage(c.code,c.hash))continue;
      const category=c.assessment.category in categories?c.assessment.category as keyof typeof categories:'LOW';
      const existing=db.prepare('SELECT * FROM review_files WHERE candidate_id=?').get(c.id) as Inventory|undefined;if(existing&&['MODIFIED','DELETED','MISSING'].includes(existing.state))continue;
      if(existing?.category===category&&existing.view===(c.view||'UNKNOWN')&&(!settings().downloadOnly||existing.hash===c.hash))continue;
      const rows=db.prepare('SELECT * FROM review_files WHERE code=?').all(c.code) as Inventory[];
      const canonicalChange=existing&&existing.view!==(c.view||'UNKNOWN')&&['FRONT','BACK'].includes(c.view||'');const slot=canonicalChange?(availableSlot(c,rows.filter(r=>r.candidate_id!==c.id))||existing.sequence):existing?.sequence||availableSlot(c,rows);if(!slot)continue;
      const heldKey=sha(c.hash+JSON.stringify(settings()));if(getKV('reviewHeld:'+c.id,'')===heldKey)continue;
      const extension=settings().downloadOnly?path.extname(c.originalFile).slice(1):'webp';
      const relative=`${categories[category]}/${c.code}_${slot}.${extension}`,target=reviewPath(relative);
      try{
        const bytes=await renderReview(c);
        if(existing&&settings().downloadOnly&&existing.hash!==c.hash){const prior=await readFile(reviewPath(existing.path));if(sha(prior)!==existing.hash){held++;continue;}const archive=path.resolve(dataDir,'processed-archive',uid(),path.basename(existing.path));if(!archive.startsWith(dataDir+path.sep))throw new Error('Invalid archive path');await mkdir(path.dirname(archive),{recursive:true});await writeFile(archive,prior);event(c.code,'PROCESSED_ARCHIVED','Prior processed review copy archived; replaced with unchanged source bytes',{oldFile:existing.path,archive});}
        if(!existing||existing.path!==relative){try{await access(target);event(c.code,'REVIEW_COLLISION','Untracked file preserved; choose a clear review filename',{file:relative});held++;continue;}catch{/* New filename. */}}
        const temp=target+'.'+uid()+'.tmp';await writeFile(temp,bytes);await rename(temp,target);
        transaction(()=>{
          // A replacement takes the deleted image's exact item code/sequence.
          db.prepare("DELETE FROM review_files WHERE code=? AND sequence=? AND state='DELETED'").run(c.code,slot);
          db.prepare("INSERT INTO review_files VALUES (?,?,?,?,?,?,?,'PRESENT',0,?) ON CONFLICT(candidate_id) DO UPDATE SET sequence=excluded.sequence,view=excluded.view,category=excluded.category,path=excluded.path,hash=excluded.hash,state='PRESENT',missing_since=0").run(c.id,c.code,slot,c.view||'UNKNOWN',category,relative,sha(bytes),now());
          db.prepare("UPDATE replacement_requests SET status='REPLACED' WHERE code=? AND sequence=? AND status IN ('QUEUED','SEARCHING','WAITING_SOURCE')").run(c.code,slot);event(c.code,'REVIEW_FILE',`Prepared ${relative}`,{candidate:c.id,rights:c.rights});
        });
        if(existing&&existing.path!==relative)await unlink(reviewPath(existing.path)).catch(()=>{});written++;
      }catch(e){held++;setKV('reviewHeld:'+c.id,heldKey);event(c.code,'REVIEW_HELD',String(e),{candidate:c.id});}
    }
    setKV('reviewFolderHealth','Ready');setKV('reviewFolderLastScan',now());return {written,held,...deletion};
  }finally{clearInterval(heartbeat);db.prepare('DELETE FROM review_sync_lock WHERE owner=?').run(owner);}
}
export function reviewFolderDashboard(){return {root:reviewRoot,health:getKV('reviewFolderHealth','Not scanned'),lastScan:getKV('reviewFolderLastScan',null),categories:db.prepare("SELECT category,count(*) count FROM review_files WHERE state IN ('PRESENT','MODIFIED') GROUP BY category").all(),files:db.prepare('SELECT * FROM review_files ORDER BY created_at DESC LIMIT 100').all(),replacements:db.prepare('SELECT * FROM replacement_requests ORDER BY created_at DESC LIMIT 100').all()};}

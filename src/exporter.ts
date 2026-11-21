import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { db, event, getCandidate, getProduct, now, saveProduct, transaction, uid } from './db.js';
import { exportEligible, localFile } from './images.js';
import type { Candidate, Product } from './types.js';
import { selections } from './gallery.js';
export function csv(rows:Record<string,unknown>[]) {
  const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const quote=(v:unknown)=> {let s=typeof v==='object'?JSON.stringify(v??''):String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\uFEFF'+[headers.map(quote).join(','),...rows.map(r=>headers.map(h=>quote(r[h])).join(','))].join('\r\n');
}
export async function createExport(incremental=false,codes?:string[]) {
  const products=(db.prepare('SELECT body FROM products WHERE workflow IN (\'READY_TO_EXPORT\',\'EXPORTED\') ORDER BY code').all() as {body:string}[]).map(r=>JSON.parse(r.body) as Product);
  const selected:{p:Product;c:Candidate}[]=[];
  for(const p of products) {
    if(codes?.length&&!codes.includes(p.code))continue;
    const slots=selections(p);const {settings}=await import('./db.js');
    if(slots.length!==settings().requiredImages||!slots.some(s=>s.slot===1&&s.view==='FRONT')||(settings().requiredImages>1&&!slots.some(s=>s.slot===2&&s.view==='BACK')))continue;
    const images=slots.map(s=>getCandidate(s.candidateId));if((await Promise.all(images.map(c=>exportEligible(p,c)))).some(valid=>!valid))continue;
    if(incremental&&images.every(c=>db.prepare('SELECT 1 FROM exported_assets WHERE code=? AND candidate_id=? AND hash=? AND settings_hash=?').get(p.code,c!.id,c!.finalHash,c!.settingsHash)))continue;
    for(const c of images)selected.push({p,c:c!});
  }
  if(!selected.length)throw new Error('No approved, rights-cleared, quality-passing images eligible for this export');
  const id=uid(),file=`exports/${id}.zip`,stamp=now();
  const manifest=selected.map(({p,c})=>({item_code:p.code,sequence:c.finalSlot,view:c.view,original_sheet:p.sheet,original_row:p.row,filename:c.finalFile.split('/').at(-1),confidence:c.assessment.category,score:c.assessment.score,reviewer:c.reviewedBy,review_reason:c.reviewReason,source:c.source,page_url:c.pageUrl,image_url:c.imageUrl,rights:c.rights,rights_evidence:c.rightsEvidence,rights_verified_by:c.rightsReviewer,attribution:c.attribution,width:'',height:'',sha256:c.finalHash,transforms:c.transforms,timestamp:stamp,status:'EXPORTED'}));
  const {settings}=await import('./db.js');for(let i=0;i<manifest.length;i++){manifest[i].width=String(settings().downloadOnly?selected[i].c.width:settings().width);manifest[i].height=String(settings().downloadOnly?selected[i].c.height:settings().height);}
  try {
    await new Promise<void>((resolve,reject)=>{
      const output=createWriteStream(localFile(file));const zip=archiver('zip',{zlib:{level:6}});output.on('close',resolve);output.on('error',reject);zip.on('error',reject);zip.on('warning',reject);zip.pipe(output);
      for(const {c} of selected)zip.file(localFile(c.finalFile),{name:c.finalFile.split('/').at(-1)!});
      zip.append(csv(manifest),{name:'manifest.csv'});zip.append('Only approved, commercially cleared, quality-reviewed assets are included. Observe attribution and license obligations in manifest.csv.\n',{name:'READ-ME.txt'});void zip.finalize().catch(reject);
    });
    // Ensure all files are still eligible after asynchronous archiving.
    for(const {p,c} of selected)if(!await exportEligible(getProduct(p.code)!,getCandidate(c.id)))throw new Error('Eligibility changed during export. Retry.');
    transaction(()=>{
      const uniqueProducts=[...new Map(selected.map(({p})=>[p.code,p])).values()];
      for(const p of uniqueProducts){const current=getProduct(p.code)!;if(current.updatedAt!==p.updatedAt)throw new Error('Product changed during export. Retry.');current.workflow='EXPORTED';saveProduct(current);}
      for(const {p,c} of selected)db.prepare('INSERT OR IGNORE INTO exported_assets VALUES (?,?,?,?,?)').run(p.code,c.id,c.finalHash,c.settingsHash,id);
      db.prepare('INSERT INTO exports VALUES (?,?,?)').run(id,JSON.stringify({file,count:selected.length,manifest}),stamp);event('','EXPORT',`${selected.length} cleared images exported`,{id});
    });
  } catch(e){await unlink(localFile(file)).catch(()=>{});throw e;}
  return {id,count:selected.length,url:`/api/exports/${id}`,manifest};
}
export async function exportBytes(id:string) {const r=db.prepare('SELECT body FROM exports WHERE id=?').get(id) as {body:string}|undefined;if(!r)throw new Error('Export not found');return readFile(localFile(JSON.parse(r.body).file));}

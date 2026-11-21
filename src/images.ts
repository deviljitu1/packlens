import sharp from 'sharp';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { candidates, dataDir, db, event, getCandidate, getProduct, now, saveCandidate, saveProduct, settings, uid } from './db.js';
import { assess, assessCandidate } from './matcher.js';
import type { Candidate, Evidence, Product, Rights } from './types.js';
import type { ImageView } from './types.js';
import { selections,selected,selectImage } from './gallery.js';
import { analyzeImage,visualQualityFailures } from './quality.js';
import { localImageTool } from './local-tools.js';
import {reassessProduct} from './confidence.js';
export const sha = (data: Buffer|string) => createHash('sha256').update(data).digest('hex');
export const settingsHash = () => { const {downloadOnly,width,height,format,quality,background,margin,sharpen,upscale,removeBackground,aiUpscale,denoise}=settings();return sha(JSON.stringify(downloadOnly?{mode:'original-bytes',requiredImages:settings().requiredImages}:{width,height,format,quality,background,margin,sharpen,upscale,removeBackground,aiUpscale,denoise})); };
export const cleared = (r:Rights) => r==='OWNED_PHOTO'||r==='CONFIRMED_COMMERCIAL_USE';
export const localFile = (relative:string) => { const result=path.resolve(dataDir,relative);if(!result.startsWith(dataDir+path.sep))throw new Error('Invalid asset path');return result; };
export async function addImage(code:string, buffer:Buffer, info:{source:string;pageUrl:string;imageUrl:string;evidence:Evidence;rights?:Rights;rightsEvidence?:string;rightsReviewer?:string;attribution?:string;view?:ImageView}) {
  const p=getProduct(code);if(!p)throw new Error('Product not found');
  if(p.ownBrand&&info.source!=='owned')throw new Error('Own-brand items require an uploaded store photograph');
  if(buffer.length>25*1024*1024)throw new Error('Image exceeds 25 MB');
  const meta=await sharp(buffer,{limitInputPixels:60_000_000}).metadata();
  if(!['jpeg','png','webp'].includes(meta.format||'')||!meta.width||!meta.height||(meta.pages||1)>1)throw new Error('Use a single-frame JPEG, PNG or WebP image');
  const qualityAnalysis=await analyzeImage(buffer);
  if(info.source!=='owned'&&qualityAnalysis.failures.length)throw new Error('Rejected poor internet image: '+qualityAnalysis.failures.join('; '));
  const hash=sha(buffer), old=candidates(code).find(c=>c.hash===hash);
  if(old?.decision==='REJECTED'||db.prepare('SELECT 1 FROM image_rejections WHERE code=? AND hash=?').get(code,hash))throw new Error('Previously rejected/deleted image excluded; searching for a different image');
  if(old)return old;
  if(candidates(code).filter(c=>c.decision!=='REJECTED').length>=5)throw new Error('Five active images already saved for this product. Reject an unsuitable image before requesting a replacement.');
  const id=uid(); const file=`originals/${hash}.${meta.format==='jpeg'?'jpg':meta.format}`;
  await writeFile(localFile(file),buffer,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const pixels=await sharp(buffer).rotate().resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
  let bits='';for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits+=pixels[y*9+x]>pixels[y*9+x+1]?'1':'0';
  const warnings:string[]=[...qualityAnalysis.warnings,...qualityAnalysis.failures];
  if(Math.min(meta.width,meta.height)<320)warnings.push('Low source resolution; inspect label legibility');
  if(Math.max(meta.width/meta.height,meta.height/meta.width)>5)warnings.push('Unusual aspect ratio; inspect cropping');
  warnings.push('Human check required for blur, watermark, full pack, front view and artwork');
  const c:Candidate={id,code,...info,rights:info.rights||'UNVERIFIED',rightsEvidence:info.rightsEvidence||'',rightsReviewer:info.rightsReviewer||'',attribution:info.attribution||'',
    assessment:assess(p,info.evidence,settings()), originalFile:file,hash,perceptualHash:BigInt('0b'+bits).toString(16).padStart(16,'0'),width:meta.width,height:meta.height,
    decision:'PENDING',reviewedBy:'',reviewReason:'',finalFile:'',finalHash:'',settingsHash:'',quality:'PENDING',warnings,transforms:[],createdAt:now(),qualityAnalysis};
  saveCandidate(c);
  if(!p.approvedCandidate){p.matching=c.assessment.category;p.workflow='AWAITING_REVIEW';saveProduct(p);}
  event(code,'CANDIDATE','Original image saved',{id,source:info.source,hash,assessment:c.assessment});return c;
}
export function approve(id:string,reviewer:string,reason:string,override=false,slot=1,view:ImageView='FRONT') {
  let c=getCandidate(id);if(!c)throw new Error('Candidate not found');reassessProduct(c.code);c=getCandidate(id)!;const p=getProduct(c.code)!;
  if(c.rights==='PROHIBITED')throw new Error('Prohibited image cannot be approved');
  if(c.assessment.vetoes.length&&(!override||!reason.trim()))throw new Error('Mismatch requires explicit override with a resolution reason');
  if((p.conflict||p.size.includes('/'))&&!reason.trim())throw new Error('Resolve the workbook conflict or alternate size in reviewer notes');
  selectImage(p,{candidateId:id,slot,view});c.view=view;c.viewVerified=true;
  if(c.finalSlot!==slot){c.finalFile='';c.finalHash='';c.quality='PENDING';}
  c.decision='APPROVED';c.reviewedBy=reviewer;c.reviewReason=reason;saveCandidate(c);
  p.reviewer=reviewer;p.reviewReason=reason;p.matching=c.assessment.category;p.rights=c.rights;p.workflow='APPROVED';p.quality='PENDING';saveProduct(p);
  event(c.code,'APPROVED',override?'Match overridden with recorded resolution':'Match approved',{id,reviewer,reason,assessment:c.assessment});
  return c;
}
export type EnhanceOptions={ crop?:{left:number;top:number;width:number;height:number}; removeBackground?:boolean;aiUpscale?:boolean; qualityReviewed?:boolean; qualityNotes?:string };
export async function enhance(id:string,options:EnhanceOptions={}) {
  if(settings().downloadOnly)throw new Error('Image alteration is disabled in download-only mode. Use original-file review/export.');
  let c=getCandidate(id);if(!c)throw new Error('Candidate not found');let p=getProduct(c.code)!;
  const selection=selected(p,id);if(!selection||c.decision!=='APPROVED')throw new Error('Approve the match before enhancement');
  if(!cleared(c.rights)||!c.rightsEvidence.trim()||!c.rightsReviewer.trim())throw new Error('Commercial-use rights and verifier evidence are required');
  const cfg=settings(), cfgHash=settingsHash();p.workflow='ENHANCING';saveProduct(p);
  try {
    let input:Buffer=await readFile(localFile(c.originalFile));const transforms=['EXIF orientation corrected'];
    if(options.aiUpscale||cfg.aiUpscale){input=await localImageTool('upscale',input);transforms.push('Local FSRCNN 2x; inspect packaging text for artifacts');}
    if(options.removeBackground||cfg.removeBackground){input=await localImageTool('background',input);transforms.push('Local rembg u2netp CPU background removal; inspect edges and lettering');}
    let pipeline=sharp(input,{limitInputPixels:60_000_000}).rotate();
    if(cfg.denoise){pipeline=pipeline.median(3);transforms.push('Median denoise 3px; inspect fine lettering');}
    if(options.crop){pipeline=pipeline.extract(options.crop);transforms.push(`Crop ${JSON.stringify(options.crop)}`);}
    const boxWidth=cfg.width-cfg.margin*2,boxHeight=cfg.height-cfg.margin*2;
    const subject=await pipeline.resize(boxWidth,boxHeight,{fit:'inside',withoutEnlargement:!cfg.upscale}).png().toBuffer();
    let output=sharp({create:{width:cfg.width,height:cfg.height,channels:4,background:cfg.background}}).composite([{input:subject,gravity:'centre'}]).flatten({background:cfg.background});
    if(cfg.sharpen){output=output.sharpen({sigma:.5});transforms.push('Conservative sharpening sigma 0.5');}
    const buf=await output.toFormat(cfg.format,{quality:cfg.quality}).toBuffer();const finalMeta=await sharp(buf).metadata();
    if(finalMeta.width!==cfg.width||finalMeta.height!==cfg.height||finalMeta.format!==cfg.format)throw new Error('Output validation failed');
    const hash=sha(buf),ext=cfg.format==='jpeg'?'jpg':cfg.format;const folder=`enhanced/${id}/${hash}`;await mkdir(localFile(folder),{recursive:true});
    const file=`${folder}/${c.code}_${selection.slot}.${ext}`,temp=file+'.tmp';await writeFile(localFile(temp),buf);await rename(localFile(temp),localFile(file));
    // Approval or rights may have been changed while processing. Never overwrite that newer decision.
    c=getCandidate(id)!;p=getProduct(c.code)!;
    if(selected(p,id)?.slot!==selection.slot||c.decision!=='APPROVED'||!cleared(c.rights)||cfgHash!==settingsHash())throw new Error('Approval, rights or settings changed during processing; run enhancement again');
    c.finalFile=file;c.finalHash=hash;c.settingsHash=cfgHash;c.finalSlot=selection.slot;
    const low=Math.min(c.width,c.height)<100||(c.qualityAnalysis?.failures.length||0)>0||visualQualityFailures(c).length>0;
    c.quality=low?'FAIL':options.qualityReviewed&&options.qualityNotes?.trim()?'PASS':'WARNING';
    c.transforms=[...transforms,`Contain ${boxWidth}x${boxHeight}; upscale ${cfg.upscale?'enabled':'disabled'}`,`Composite ${cfg.background}`,`${cfg.width}x${cfg.height} ${cfg.format} quality ${cfg.quality}`];
    if(cfg.upscale&&Math.max(boxWidth/c.width,boxHeight/c.height)>2)c.warnings.push('Upscaling over 2x may reduce label quality');
    if(low)c.warnings.push('Source failed image-quality checks; obtain a better full-pack photograph',...visualQualityFailures(c));
    saveCandidate(c);await refreshReadiness(p);
    event(c.code,'ENHANCED','Output generated and dimensions verified',{id,quality:c.quality,qualityNotes:options.qualityNotes,hash,transforms:c.transforms});return c;
  } catch(e) {p=getProduct(p.code)!;if(p.workflow==='ENHANCING'){p.workflow='APPROVED';saveProduct(p);}event(p.code,'ENHANCE_ERROR',String(e));throw e;}
}
export async function exportEligible(p:Product,c:Candidate|undefined) {
  if(!c||!selected(p,c.id)||!['READY_TO_EXPORT','EXPORTED'].includes(p.workflow)||p.quality!=='PASS'||c.finalSlot!==selected(p,c.id)?.slot||c.view!==selected(p,c.id)?.view)return false;
  return candidateOutputValid(c);
}
export async function candidateOutputValid(c:Candidate){
  if(c.decision!=='APPROVED'||!cleared(c.rights)||!c.rightsEvidence||!c.rightsReviewer||c.quality!=='PASS'||c.settingsHash!==settingsHash()||!c.finalFile||!c.viewVerified)return false;
  try {await access(localFile(c.finalFile));const bytes=await readFile(localFile(c.finalFile));const meta=await sharp(bytes).metadata();return settings().downloadOnly?sha(bytes)===c.hash&&c.finalHash===c.hash&&meta.width===c.width&&meta.height===c.height:sha(bytes)===c.finalHash&&meta.width===settings().width&&meta.height===settings().height&&meta.format===settings().format;}catch{return false;}
}
export async function prepareOriginal(id:string,options:{qualityReviewed:boolean;qualityNotes:string}){
  let c=getCandidate(id);if(!c)throw new Error('Candidate not found');let p=getProduct(c.code)!;const selection=selected(p,id),expectedSettings=settingsHash();if(!selection||c.decision!=='APPROVED')throw new Error('Approve the match first');if(!cleared(c.rights)||!c.rightsEvidence||!c.rightsReviewer)throw new Error('Commercial-use rights and verifier evidence are required');
  const bytes=await readFile(localFile(c.originalFile));if(sha(bytes)!==c.hash)throw new Error('Original checksum changed');c.qualityAnalysis ||= await analyzeImage(bytes);const failures=[...c.qualityAnalysis.failures,...visualQualityFailures(c)];if(failures.length)throw new Error(failures.join('; '));if(!options.qualityReviewed||!options.qualityNotes.trim())throw new Error('Original-image quality review and notes are required');
  const folder=`approved-originals/${c.id}`;await mkdir(localFile(folder),{recursive:true});const file=`${folder}/${c.code}_${selection.slot}${path.extname(c.originalFile)}`;await writeFile(localFile(file),bytes);if(sha(await readFile(localFile(file)))!==c.hash)throw new Error('Original-copy checksum failed');
  const current=getCandidate(id)!,currentProduct=getProduct(c.code)!;if(current.hash!==c.hash||current.decision!=='APPROVED'||!cleared(current.rights)||selected(currentProduct,id)?.slot!==selection.slot||selected(currentProduct,id)?.view!==current.view||settingsHash()!==expectedSettings||visualQualityFailures(current).length)throw new Error('Approval, view, rights or settings changed during preparation; review again');current.qualityAnalysis ||= c.qualityAnalysis;c=current;p=currentProduct;
  c.finalFile=file;c.finalHash=c.hash;c.finalSlot=selection.slot;c.settingsHash=settingsHash();c.quality='PASS';c.transforms=['Original bytes copied without image processing'];saveCandidate(c);await refreshReadiness(p);event(c.code,'ORIGINAL_PREPARED','Unchanged original prepared; SHA-256 equality verified',{id,sequence:selection.slot,qualityNotes:options.qualityNotes});return c;
}
export async function refreshReadiness(p:Product){
  const slots=selections(p),required=settings().requiredImages,version=p.updatedAt;
  let ready=slots.length===required&&slots.some(s=>s.slot===1&&s.view==='FRONT')&&(required===1||slots.some(s=>s.slot===2&&s.view==='BACK'));
  const hashes=new Set<string>();
  for(const slot of slots){const image=getCandidate(slot.candidateId);if(!image||hashes.has(image.hash)||image.finalSlot!==slot.slot||image.view!==slot.view||!await candidateOutputValid(image)){ready=false;break;}hashes.add(image.hash);}
  if(getProduct(p.code)!.updatedAt!==version)throw new Error('Product changed during readiness checks; retry with the current record');
  p.quality=ready?'PASS':'PENDING';p.workflow=ready?'READY_TO_EXPORT':'APPROVED';saveProduct(p);return ready;
}

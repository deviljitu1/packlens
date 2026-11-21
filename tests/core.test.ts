import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import type { Product } from '../src/types.js';
import {pilotInput} from './catalog-fixture.js';
process.env.PACKLENS_DATA_DIR=path.resolve('test-results/core-data');
const {db,getProduct,saveProduct,getCandidate,saveCandidate,setKV,settings,candidates}=await import('../src/db.js');
const {readBook,autoMap,importSheet}=await import('../src/importer.js');
const {assess,assessCandidate,verificationKey}=await import('../src/matcher.js');
const {addImage,approve,enhance,prepareOriginal,localFile,exportEligible}=await import('../src/images.js');
const {createExport}=await import('../src/exporter.js');
const {enqueue,queueControl}=await import('../src/queue.js');
const {enqueueVisual,processVisualBatch,saveVerification,quotaReason}=await import('../src/verification.js');
const {emptyEvidence}=await import('../src/types.js');
const {checkNames}=await import('../src/codex-client.js');
const {app}=await import('../src/server.js');
const {default:request}=await import('supertest');
const {SourceError,permittedUrl,failSource}=await import('../src/sources.js');
let book:Awaited<ReturnType<typeof readBook>>;let photo:Buffer;
beforeAll(async()=>{db.exec('DELETE FROM origins;DELETE FROM imports;DELETE FROM tasks;DELETE FROM review_files;DELETE FROM image_rejections;DELETE FROM replacement_requests;DELETE FROM candidates;DELETE FROM products;DELETE FROM events;DELETE FROM exports;DELETE FROM exported_assets;DELETE FROM visual_jobs;DELETE FROM verifications;DELETE FROM codex_runs;');setKV('settings',{...settings(),requiredImages:1});book=await readBook(await pilotInput(),'pilot.xlsx');photo=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#fff"/><rect x="100" y="50" width="600" height="900" fill="#a7b9cc"/><text x="400" y="300" text-anchor="middle" font-size="50" font-family="Arial">SYNTHETIC QA FIXTURE</text><text x="400" y="550" text-anchor="middle" font-size="45" font-family="Arial">NOT PRODUCT PHOTOGRAPHY</text></svg>')).png().toBuffer();});
describe('workbook importer',()=>{
  it('imports exactly 50 pilot rows, reimport is idempotent, retains barcodes and instructions',()=>{
    const sheet=book.sheets.find(s=>s.name==='Pilot 50')!;expect(sheet.rows).toHaveLength(50);
    expect(importSheet(book,sheet.name,autoMap(sheet.headers),'pilot.xlsx').added).toBe(50);
    expect(importSheet(book,sheet.name,autoMap(sheet.headers),'pilot.xlsx').unchanged).toBe(50);
    expect((db.prepare('SELECT count(*) n FROM products').get() as any).n).toBe(50);
    expect(getProduct('198')!.barcodes.length).toBe(5);expect(getProduct('202')!.barcodes.length).toBe(8);expect(book.instructions.find(s=>s.sheet==='Read First')!.rows.length).toBeGreaterThan(10);
  });
  it('preserves all 69 conflict origins, approval remains unset',()=>{
    const s=book.sheets.find(s=>s.name==='Existing conflicts')!;expect(s.rows.length).toBe(69);const r=importSheet(book,s.name,autoMap(s.headers),'pilot.xlsx',true);expect(r.errors).toHaveLength(0);expect(r.total).toBe(69);
    expect((db.prepare("SELECT count(DISTINCT code) n FROM origins WHERE sheet='Existing conflicts'").get() as any).n).toBe(69);for(const row of s.rows){const p=getProduct(row[s.headers[0]])!;expect(p.conflict).not.toBe('');expect(p.approvedCandidate).toBeNull();}
  });
  it('preserves text IDs and Excel zero formats, reports invalid and duplicate rows',async()=>{
    const x=new ExcelJS.Workbook();const s=x.addWorksheet('Items');s.addRow(['SKU','Title']);s.addRow(['0007','Tea']);s.addRow([8,'Salt']);s.getCell('A3').numFmt='000000';s.addRow(['../bad','Bad']);s.addRow(['0007','Duplicate']);
    const b=await readBook(Buffer.from(await x.xlsx.writeBuffer()),'zeros.xlsx');const r=importSheet(b,'Items',autoMap(b.sheets[0].headers),'zeros.xlsx');expect(getProduct('0007')?.code).toBe('0007');expect(getProduct('000008')?.code).toBe('000008');expect(r.errors.length).toBe(2);
  });
  it('routes own brands to photos and preserves ambiguous pack sizes',()=>{for(const c of ['213','215','52554'])expect(getProduct(c)!.workflow).toBe('NEEDS_STORE_PHOTO');for(const c of ['43671','9451'])expect(getProduct(c)!.size).toContain('/');});
  it('allows explicit mapping of an unfamiliar schema without dropping its extra attributes',async()=>{const custom=await readBook(Buffer.from('Product Ref,Display Label,Extra Attribute\n000099,Example product,Retain me\n'),'custom.csv');expect(custom.sheets[0].headers).toContain('Product Ref');const result=importSheet(custom,'CSV',{code:'Product Ref',name:'Display Label'},'custom.csv');expect(result.errors).toEqual([]);expect(getProduct('000099')!.original['Extra Attribute']).toBe('Retain me');});
});
describe('deterministic matching',()=>{
  const evidence=(code:string)=>{const p=getProduct(code)!;return {...emptyEvidence,title:p.productName,brand:p.brand,size:p.size,packagingVerified:true,packagingNotes:'Test observation'};};
  it('hard-vetoes 10 kg for item 202 and Sharbati/multigrain substitutions',()=>{
    const p=getProduct('202')!;expect(assess(p,evidence('201'),settings()).vetoes).toContain('Size mismatch');
    expect(assess(p,evidence('200'),settings()).category).toBe('LOW');expect(assess(p,evidence('198'),settings()).category).toBe('LOW');
  });
  it('never rates a single pack HIGH for promo/multipack products',()=>{
    for(const code of ['49946','8554']){const p=getProduct(code)!,e=evidence(code);e.size=code==='49946'?'100 g':'130 g';e.title=code==='49946'?'Lifebuoy Soap':'Pepsodent Toothpaste';expect(assess(p,e,settings()).category).toBe('LOW');}
  });
  it('requires more than a product title, and keeps alternate sizes below HIGH',()=>{
    const p=getProduct('202')!;expect(assess(p,{...evidence('202'),packagingVerified:false},settings()).category).not.toBe('HIGH');
    for(const code of ['43671','9451'])expect(assess(getProduct(code)!,evidence(code),settings()).category).not.toBe('HIGH');
  });
  it('source-confirmed barcode mismatch vetoes even exact title',()=>{const e={...evidence('202'),barcode:'0000000000001',barcodeVerified:true};expect(assess(getProduct('202')!,e,settings()).vetoes).toContain('Source-confirmed barcode disagrees');});
});
describe('unchanged original downloads and export gates',()=>{
  let id='';
  it('saves real original, deduplicates bytes, unverified rights cannot enhance/export',async()=>{
    const p=getProduct('202')!;const c=await addImage('202',photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:p.size}});id=c.id;
    expect((await addImage('202',photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:c.evidence})).id).toBe(id);
    approve(id,'QA','Manual test photo');await expect(prepareOriginal(id,{qualityReviewed:true,qualityNotes:'Test'})).rejects.toThrow('Commercial-use rights');expect(await exportEligible(getProduct('202')!,getCandidate(id))).toBe(false);
  });
  it('preserves original pixels/format/bytes and exports only cleared originals with a manifest',async()=>{
    const c=getCandidate(id)!;c.rights='OWNED_PHOTO';c.rightsEvidence='Synthetic QA fixture, not a product photo';c.rightsReviewer='QA';saveCandidate(c);approve(id,'QA','Offline pipeline test only');
    const out=await prepareOriginal(id,{qualityReviewed:true,qualityNotes:'Synthetic fixture inspected; bytes must remain identical'});const buf=await readFile(localFile(out.finalFile));const metadata=await sharp(buf).metadata();expect([metadata.width,metadata.height,metadata.format]).toEqual([800,1000,'png']);expect(buf.equals(photo)).toBe(true);
    const exported=await createExport();expect(exported.manifest.map(m=>m.filename)).toEqual(['202_1.png']);expect(exported.manifest[0].rights).toBe('OWNED_PHOTO');expect((await createExport(false)).count).toBe(1);await expect(createExport(true)).rejects.toThrow('No approved');
  });
  it('blocks prohibited rights, stale settings, missing files, and opaque background claims',async()=>{
    const p=getProduct('202')!,c=getCandidate(id)!;const prior=c.rights;c.rights='PROHIBITED';expect(await exportEligible(p,c)).toBe(false);c.rights=prior;
    const cfg=settings();setKV('settings',{...cfg,requiredImages:5});expect(await exportEligible(p,c)).toBe(false);setKV('settings',cfg);c.finalFile='approved-originals/nonexistent.png';expect(await exportEligible(p,c)).toBe(false);
  });
  it('rejects generic source images for own brand',async()=>{await expect(addImage('213',photo,{source:'off',pageUrl:'',imageUrl:'',evidence:emptyEvidence})).rejects.toThrow('store photograph');});
  it('blocks image alteration in the current download-only workflow',async()=>{await expect(enhance(id,{removeBackground:true,aiUpscale:true})).rejects.toThrow('alteration is disabled');});
});
describe('queue, API and source controls',()=>{
  it('avoids duplicate queue entries; pause/resume/stop are durable',()=>{const code='198';expect(enqueue([code,code]).queued).toBe(1);expect(enqueue([code]).queued).toBe(0);expect(queueControl('pause').paused).toBe(true);expect(queueControl('resume').paused).toBe(false);queueControl('stop');expect((db.prepare('SELECT status FROM tasks WHERE code=?').get(code) as any).status).toBe('CANCELLED');});
  it('returns database-backed counts and filters; rejects cross-origin writes',async()=>{
    expect((await request(app).get('/api/products?sheet=Pilot%2050')).body.total).toBe(50);expect((await request(app).get('/api/products?q=202')).body.rows.some((p:Product)=>p.code==='202')).toBe(true);
    const res=await request(app).post('/api/jobs').set('Origin','https://untrusted.example').send({limit:1});expect(res.status).toBe(403);
    const invalid=await request(app).post('/api/candidates/not-found/review').send({action:'approve'});expect(invalid.status).toBe(400);
  });
  it('rejects private destinations and pauses a source on 403/429',async()=>{
    const {sources}=await import('../src/db.js');const s={...sources().find(s=>s.id==='supplier')!,enabled:true,accessAllowed:true,authorization:'QA',allowedHosts:['127.0.0.1']};
    await expect(permittedUrl('https://127.0.0.1/a',s)).rejects.toThrow('Private');failSource(s,new SourceError('HTTP 429','RATE_LIMIT'));expect(s.blockedUntil).toBeGreaterThan(Date.now());
    const until=s.blockedUntil,health=s.health;failSource(s,new SourceError('Source paused: '+s.health,'BLOCKED'));expect(s.blockedUntil).toBe(until);expect(s.health).toBe(health);
  });
});
describe('Codex visual review policy and caching',()=>{
  const exact=(id:string)=>({candidateId:id,verdict:'EXACT_MATCH' as const,checks:Object.fromEntries(checkNames.map(k=>[k,{state:'MATCH' as const,reason:'Injected deterministic test result; not real Codex output'}])) as any,visibleText:'TEST FIXTURE',visibleBarcode:'',differences:[],reasons:['Mocked transport QA only']});
  it('merges structured visual results with deterministic vetoes and never approves',async()=>{
    const p=getProduct('198')!;const c=await addImage(p.code,photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:'10 kg'}});
    saveVerification(c,p,exact(c.id),'CODEX_CLI');expect(getCandidate(c.id)!.assessment.category).toBe('LOW');expect(getProduct(p.code)!.approvedCandidate).toBeNull();
  });
  it('unchanged image/catalog reuses verification; changed catalog invalidates fingerprint',async()=>{
    const p=getProduct('200')!;const c=await addImage(p.code,photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:p.size}});
    saveVerification(c,p,exact(c.id),'CODEX_CLI');expect(enqueueVisual([c.id],false).cached).toBe(1);expect(enqueueVisual([c.id],false).queued).toBe(0);
    const key=verificationKey(p,c);p.size='1 kg';saveProduct(p);expect(verificationKey(p,c)).not.toBe(key);expect(enqueueVisual([c.id],false).queued).toBe(1);
  });
  it('uncertain Codex results and local OCR can never yield HIGH',()=>{
    const p=getProduct('202')!,c=getCandidate(p.approvedCandidate!)!;
    const result=exact(c.id);result.verdict='UNCERTAIN' as any;result.checks.weight={state:'UNCERTAIN',reason:'Weight not legible'};saveVerification(c,p,result,'CODEX_CLI');expect(getCandidate(c.id)!.assessment.category).not.toBe('HIGH');expect(getProduct(p.code)!.approvedCandidate).toBeNull();
  });
  it('quota threshold pauses calls and uses local OCR/manual fallback',async()=>{
    setKV('visualSettings',{enabled:true,batchSize:2,maxCandidatesPerDay:50,maxTokensPerDay:150000,pauseAtPercent:95,fallbackOCR:true});setKV('visualCodexPaused','');
    const p=getProduct('201')!,c=await addImage(p.code,photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:p.size}});enqueueVisual([c.id],false);
    const jobs=db.prepare("SELECT * FROM visual_jobs WHERE candidate_id=? AND status='QUEUED'").all(c.id) as any[];let calls=0;
    await processVisualBatch(jobs,{status:async()=>({available:true,authMode:'chatgpt',windows:[{usedPercent:100,resetsAt:null,windowDurationMins:300}],limitReached:true,at:new Date().toISOString(),error:''}),review:async()=>{calls++;throw new Error('must not call');},ocr:async()=> 'AASHIRVAAD 10 KG'});
    expect(calls).toBe(0);expect(getCandidate(c.id)!.visual!.engine).toBe('LOCAL_OCR');expect(getCandidate(c.id)!.assessment.category).not.toBe('HIGH');
  });
  it('runs 50-pilot routing with synthetic images and injected structured results, not 50 live visual reviews',async()=>{
    db.exec('DELETE FROM visual_jobs;DELETE FROM verifications;DELETE FROM codex_runs;');setKV('visualCodexPaused','');setKV('visualSettings',{enabled:true,batchSize:3,maxCandidatesPerDay:50,maxTokensPerDay:150000,pauseAtPercent:95,fallbackOCR:true});
    const rows=book.sheets.find(s=>s.name==='Pilot 50')!;
    for(const row of rows.rows){const p=getProduct(row['Item Code'])!;const existing=candidates(p.code);if(!existing.length)await addImage(p.code,photo,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:p.size}});}
    const first=enqueueVisual(undefined,true);expect(first.shortlisted).toBe(50);expect(first.queued).toBe(50);
    let calls=0;
    while(true){const jobs=db.prepare("SELECT * FROM visual_jobs WHERE status='QUEUED' LIMIT 3").all() as any[];if(!jobs.length)break;for(const j of jobs)db.prepare("UPDATE visual_jobs SET status='RUNNING' WHERE id=?").run(j.id);
      await processVisualBatch(jobs,{status:async()=>({available:true,authMode:'chatgpt',windows:[{usedPercent:10,resetsAt:null,windowDurationMins:300}],limitReached:false,at:new Date().toISOString(),error:''}),review:async items=>{calls++;return {results:items.map(i=>{const r=exact(i.candidateId);r.verdict='UNCERTAIN' as any;r.checks.packagingText={state:'NOT_VISIBLE',reason:'Synthetic fixture; not real product photography'};return r;}),usage:{input_tokens:100,output_tokens:100,cached_input_tokens:0},model:'INJECTED TEST TRANSPORT'};},ocr:async()=>''});
    }
    expect(calls).toBe(17);expect((db.prepare('SELECT count(*) n FROM verifications').get() as any).n).toBe(50);expect(enqueueVisual(undefined,true).cached).toBe(50);expect(enqueueVisual(undefined,true).queued).toBe(0);
    for(const row of rows.rows){const p=getProduct(row['Item Code'])!;expect(p.matching).not.toBe('HIGH');expect(p.approvedCandidate).toBeNull();}
  });
});

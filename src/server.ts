import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, candidates, dataDir, event, getCandidate, getKV, getProduct, now, saveCandidate, saveProduct, saveSource, setKV, settings, sources, transaction, uid } from './db.js';
import { aliases, autoMap, importSheet, readBook } from './importer.js';
import { addImage, approve, enhance,prepareOriginal, localFile, settingsHash } from './images.js';
import { createExport, csv, exportBytes } from './exporter.js';
import { enqueue, queueControl } from './queue.js';
import { adapterFor, assertSource, failSource, saveLead } from './sources.js';
import { assessCandidate } from './matcher.js';
import { enqueueVisual, refreshCodexStatus, visualDashboard, visualSettingsSchema } from './verification.js';
import { emptyEvidence, type Candidate, type Product, type Source } from './types.js';
import { selections,selected,removeSelection } from './gallery.js';
import { localCapabilities } from './local-tools.js';
import { reviewRoot,initReviewFolders,reviewFolderDashboard,syncReviewFolders } from './review-folders.js';
import { spawn } from 'node:child_process';
import {reassessProduct} from './confidence.js';

const text=z.string().max(10000);const reviewer=z.string().trim().min(1).max(120);
const uuid=z.string().uuid();const rights=z.enum(['OWNED_PHOTO','CONFIRMED_COMMERCIAL_USE','UNVERIFIED','PROHIBITED']);
const evidenceSchema=z.object({title:text,brand:text,size:text,variant:text,packCount:z.string().max(30),barcode:z.string().max(30),barcodeVerified:z.boolean(),packagingVerified:z.boolean(),packagingNotes:text});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:1,fields:30}});
export const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{
  const host=req.headers.host?.split(':')[0];
  if(!['127.0.0.1','localhost','[::1]'].includes(host||''))return res.status(403).json({error:'Local host required'});
  const origin=req.headers.origin;
  if(origin&&![`http://${req.headers.host}`,'http://127.0.0.1:4310','http://localhost:4310','http://127.0.0.1:5173','http://localhost:5173',`http://127.0.0.1:${process.env.PORT||4310}`].includes(origin))return res.status(403).json({error:'Cross-origin requests are not allowed'});
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');next();
});
app.use(express.json({limit:'1mb'}));
app.get('/api/health',(_req,res)=>res.json({status:'ok',database:'SQLite WAL',at:now(),worker:getKV('workerHeartbeat',null),demo:false}));
app.get('/api/overview',(_req,res)=>{
  const main="COALESCE(json_extract(body,'$.catalogRole'),'MAIN')='MAIN'";
  const total=Number((db.prepare('SELECT count(*) n FROM products WHERE '+main).get() as {n:number}).n);
  const conflictCount=Number((db.prepare('SELECT count(*) n FROM products WHERE NOT ('+main+')').get() as {n:number}).n);
  const group=(field:string)=>Object.fromEntries((db.prepare(`SELECT ${field} value,count(*) n FROM products WHERE ${main} GROUP BY ${field}`).all() as {value:string;n:number}[]).map(r=>[r.value,r.n]));
  const reviewed=(db.prepare('SELECT body FROM candidates').all() as {body:string}[]).map(r=>JSON.parse(r.body) as Candidate).filter(c=>c.assessment.category==='HIGH'&&c.decision!=='PENDING'&&c.reviewedBy!=='Automatic HIGH rule');
  const approved=reviewed.filter(c=>c.decision==='APPROVED').length;
  const events=db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 8').all();
  res.json({total,conflictCount,allRecords:total+conflictCount,workflow:group('workflow'),matching:group('matching'),rights:group('rights'),quality:group('quality'),tasks:db.prepare('SELECT status,count(*) n FROM tasks GROUP BY status').all(),sources:sources(),worker:getKV('workerHeartbeat',null),paused:getKV('queuePaused',false),reviewedHigh:reviewed.length,falseHigh:reviewed.length-approved,highPrecision:reviewed.length?approved/reviewed.length:null,events,current:db.prepare("SELECT code FROM tasks WHERE status='RUNNING'").get()||null});
});
app.post('/api/import/preview',upload.single('file'),async(req,res)=>{
  if(!req.file)throw new Error('Select a workbook');
  const book=await readBook(req.file.buffer,req.file.originalname),id=uid();
  const extension=/\.csv$/i.test(req.file.originalname)?'csv':'xlsx';
  await writeFile(path.join(dataDir,'imports',`${id}.${extension}`),req.file.buffer);
  setKV(`upload:${id}`,{filename:req.file.originalname,file:`imports/${id}.${extension}`});
  res.json({id,filename:req.file.originalname,sheets:book.sheets.map(s=>({name:s.name,headers:s.headers,count:s.rows.filter(r=>Object.values(r).some(Boolean)).length,preview:s.rows.slice(0,5),mapping:autoMap(s.headers)})),instructions:book.instructions,fields:Object.keys(aliases)});
});
app.post('/api/import',async(req,res)=>{
  const v=z.object({id:uuid,sheet:text,mapping:z.record(z.string(),z.string()),flagged:z.boolean().default(false)}).parse(req.body);
  const file=getKV<{filename:string;file:string}|null>(`upload:${v.id}`,null);if(!file)throw new Error('Upload expired; preview the workbook again');
  const book=await readBook(await readFile(localFile(file.file)),file.filename);
  const result=importSheet(book,v.sheet,v.mapping,file.filename,v.flagged);res.json(result);
});
app.get('/api/imports',(_req,res)=>res.json(db.prepare('SELECT id,filename,body,created_at FROM imports ORDER BY created_at DESC LIMIT 30').all()));
app.get('/api/products',(req,res)=>{
  const query=z.object({q:z.string().default(''),matching:z.string().default(''),workflow:z.string().default(''),rights:z.string().default(''),quality:z.string().default(''),department:z.string().default(''),brand:z.string().default(''),barcode:z.enum(['','yes','no']).default(''),source:z.string().default(''),sheet:z.string().default(''),sort:z.enum(['code','name','brand','size','department','matching','workflow','rights','quality']).default('code'),dir:z.enum(['asc','desc']).default('asc'),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)}).parse(req.query);
  const scope=z.enum(['main','conflicts','all']).parse(req.query.scope||(/conflict|check first/i.test(query.sheet)?'conflicts':'main'));
  const where:string[]=[],args:string[]=[];
  if(scope!=='all'){where.push("COALESCE(json_extract(body,'$.catalogRole'),'MAIN')=?");args.push(scope==='main'?'MAIN':'CONFLICT_ONLY');}
  if(query.q){where.push('(code LIKE ? OR name LIKE ? OR brand LIKE ?)');args.push(...Array(3).fill(`%${query.q}%`));}
  for(const f of ['matching','workflow','rights','quality','department','brand'] as const)if(query[f]){where.push(`${f}=?`);args.push(query[f]);}
  if(query.barcode){where.push(`json_extract(body,'$.barcodeText') ${query.barcode==='yes'?"<>''":"=''"}`);}
  if(query.sheet){where.push('EXISTS (SELECT 1 FROM origins o WHERE o.code=products.code AND o.sheet=?)');args.push(query.sheet);}
  if(query.source){where.push("EXISTS (SELECT 1 FROM candidates c WHERE c.code=products.code AND json_extract(c.body,'$.source')=?)");args.push(query.source);}
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const total=(db.prepare('SELECT count(*) n FROM products'+clause).get(...args) as {n:number}).n;
  const rows=(db.prepare(`SELECT body FROM products${clause} ORDER BY ${query.sort} ${query.dir} LIMIT ? OFFSET ?`).all(...args,query.pageSize,(query.page-1)*query.pageSize) as {body:string}[]).map(r=>JSON.parse(r.body));
  res.json({total,rows,page:query.page,pageSize:query.pageSize});
});
app.get('/api/products/:code',(req,res)=>{
  const p=getProduct(String(req.params.code));if(!p)return res.status(404).json({error:'Product not found'});
  res.json({product:p,candidates:candidates(p.code),events:db.prepare('SELECT * FROM events WHERE code=? ORDER BY id DESC LIMIT 200').all(p.code),origins:db.prepare('SELECT * FROM origins WHERE code=? ORDER BY rowid DESC LIMIT 30').all(p.code),researchUrl:`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(p.suggestedSearch)}`});
});
app.post('/api/products/:code/photo',upload.single('file'),async(req,res)=>{
  if(!req.file)throw new Error('Select an image');
  const p=getProduct(String(req.params.code));if(!p)throw new Error('Product not found');
  const info=z.object({reviewer,owned:z.enum(['true','false']),rightsEvidence:text.min(1)}).parse(req.body);
  const c=await addImage(p.code,req.file.buffer,{source:'owned',pageUrl:'',imageUrl:'',evidence:{...emptyEvidence,title:p.productName,brand:p.brand,size:p.size},rights:info.owned==='true'?'OWNED_PHOTO':'UNVERIFIED',rightsEvidence:info.rightsEvidence,rightsReviewer:info.reviewer});res.json(c);
});
app.patch('/api/candidates/:id',(req,res)=>{
  const v=z.object({evidence:evidenceSchema.optional(),rights:rights.optional(),rightsEvidence:text.optional(),rightsReviewer:reviewer.optional(),attribution:text.optional()}).parse(req.body);
  const c=getCandidate(String(req.params.id));if(!c)throw new Error('Candidate not found');
  if(v.rights&&['OWNED_PHOTO','CONFIRMED_COMMERCIAL_USE'].includes(v.rights)&&!(v.rightsEvidence??c.rightsEvidence).trim())throw new Error('Record rights evidence before clearance');
  if(v.rights==='OWNED_PHOTO'&&c.source!=='owned')throw new Error('Only user-uploaded photos can be marked owned');
  if(v.rights&&['OWNED_PHOTO','CONFIRMED_COMMERCIAL_USE'].includes(v.rights)&&!(v.rightsReviewer??c.rightsReviewer).trim())throw new Error('Rights verifier is required');
  transaction(()=>{
    Object.assign(c,v);const p=getProduct(c.code)!;c.assessment=assessCandidate(p,c,settings());
    if(v.evidence){c.decision='PENDING';c.quality='PENDING';if(selected(p,c.id)){removeSelection(p,c.id);p.workflow='AWAITING_REVIEW';p.quality='PENDING';}p.matching=c.assessment.category;}
    if(selected(p,c.id)&&v.rights){p.rights=c.rights;p.workflow='APPROVED';p.quality='PENDING';c.quality='PENDING';}
    saveCandidate(c);saveProduct(p);reassessProduct(c.code);event(c.code,'CANDIDATE_EDIT','Evidence or rights updated',{id:c.id,changes:v});
  });res.json(c);
});
app.post('/api/candidates/:id/review',(req,res)=>{
  const v=z.object({action:z.enum(['approve','reject']),reviewer,reason:text.default(''),override:z.boolean().default(false),slot:z.number().int().min(1).max(5).default(1),view:z.enum(['FRONT','BACK','NUTRITION','FSSAI','OTHER']).default('FRONT')}).parse(req.body);
  const id=String(req.params.id);if(v.action==='approve')return res.json(approve(id,v.reviewer,v.reason,v.override,v.slot,v.view));
  const c=getCandidate(id);if(!c)throw new Error('Candidate not found');
  transaction(()=>{c.decision='REJECTED';c.reviewedBy=v.reviewer;c.reviewReason=v.reason;saveCandidate(c);const p=getProduct(c.code)!;if(selected(p,id)){removeSelection(p,id);p.rights='UNVERIFIED';p.quality='PENDING';}p.workflow='AWAITING_REVIEW';saveProduct(p);reassessProduct(c.code);event(c.code,'REJECTED',v.reason||'Candidate rejected',{id,reviewer:v.reviewer,category:c.assessment.category});});res.json(c);
});
app.post('/api/products/:code/photo-needed',(req,res)=>{const v=z.object({reviewer,reason:text.min(1)}).parse(req.body);const p=getProduct(String(req.params.code));if(!p)throw new Error('Product not found');p.workflow='NEEDS_STORE_PHOTO';p.approvedCandidate=null;p.approvedImages=[];p.quality='PENDING';p.rights='UNVERIFIED';saveProduct(p);event(p.code,'PHOTO_NEEDED',v.reason,{reviewer:v.reviewer});res.json(p);});
app.post('/api/candidates/:id/enhance',async(req,res)=>{
  const v=z.object({crop:z.object({left:z.number().int().min(0),top:z.number().int().min(0),width:z.number().int().min(1),height:z.number().int().min(1)}).optional(),removeBackground:z.boolean().optional(),aiUpscale:z.boolean().optional(),qualityReviewed:z.boolean().optional(),qualityNotes:text.optional()}).parse(req.body);res.json(await enhance(String(req.params.id),v));
});
app.post('/api/candidates/:id/prepare-original',async(req,res)=>{const v=z.object({qualityReviewed:z.boolean(),qualityNotes:text}).parse(req.body);res.json(await prepareOriginal(String(req.params.id),v));});
app.get('/media/:id/:view',async(req,res)=>{const c=getCandidate(String(req.params.id));if(!c)return res.sendStatus(404);const file=req.params.view==='original'?c.originalFile:req.params.view==='final'?c.finalFile:'';if(!file)return res.sendStatus(404);res.sendFile(localFile(file));});
app.get('/api/settings',(_req,res)=>res.json({settings:settings(),capabilities:localCapabilities(),dataDir}));
app.patch('/api/settings',(req,res)=>{
  const cfg=z.object({width:z.number().int().min(64).max(4096),height:z.number().int().min(64).max(4096),format:z.enum(['webp','png','jpeg']),quality:z.number().int().min(50).max(100),background:z.string().regex(/^#[a-f0-9]{6}$/i),margin:z.number().int().min(0).max(512),sharpen:z.boolean(),upscale:z.boolean(),highThreshold:z.number().min(.8).max(1),mediumThreshold:z.number().min(.4).max(.94),watchBrowser:z.boolean(),autoApprove:z.boolean(),requiredImages:z.literal(5).default(5),removeBackground:z.boolean().default(false),aiUpscale:z.boolean().default(false),denoise:z.boolean().default(false)}).refine(s=>s.margin*2<Math.min(s.width,s.height)&&s.mediumThreshold<s.highThreshold,'Invalid margin or thresholds').parse(req.body);
  transaction(()=>{const previousHash=settingsHash();setKV('settings',cfg);const changed=previousHash!==settingsHash();
    for(const row of db.prepare('SELECT body FROM candidates').all() as {body:string}[]){const c:Candidate=JSON.parse(row.body);c.assessment=assessCandidate(getProduct(c.code)!,c,cfg);saveCandidate(c);}
    if(changed)for(const row of db.prepare("SELECT body FROM products WHERE workflow IN ('READY_TO_EXPORT','EXPORTED')").all() as {body:string}[]){const p:Product=JSON.parse(row.body);p.workflow='APPROVED';p.quality='PENDING';saveProduct(p);}event('','SETTINGS','Settings updated',{outputInvalidated:changed});});res.json(cfg);
});
app.get('/api/sources',(_req,res)=>res.json(sources()));
app.patch('/api/sources/:id',(req,res)=>{
  const source=sources().find(s=>s.id===req.params.id);if(!source)throw new Error('Source not found');
  const v=z.object({enabled:z.boolean(),priority:z.number().int().min(0).max(1000),accessAllowed:z.boolean(),authorization:text,reuse:text,searchUrl:z.string().max(3000),allowedHosts:z.array(z.string().regex(/^[a-z0-9.-]+$/i)).max(30),imageSelector:z.string().max(300),throttleMs:z.number().int().min(1000).max(3600000),timeoutMs:z.number().int().min(3000).max(60000)}).parse(req.body);
  if(v.enabled&&source.kind!=='manual'&&(!v.accessAllowed||!v.authorization.trim()||!v.allowedHosts.length))throw new Error('Enabling a source requires access authorization and an explicit host allowlist');
  if(source.kind==='off'&&v.throttleMs<7000)throw new Error('Open Food Facts minimum interval is 7 seconds');
  Object.assign(source,v);saveSource(source);event('','SOURCE_SETTINGS',`Updated ${source.name}`,v);res.json(source);
});
app.post('/api/sources/:id/reset',(_req,res)=>{const source=sources().find(s=>s.id===_req.params.id);if(!source)throw new Error('Source not found');source.blockedUntil=0;source.health='Backoff reset by user; not yet retested';saveSource(source);event('','SOURCE_RESET',source.name);res.json(source);});
app.post('/api/products/:code/extract',async(req,res)=>{
  const v=z.object({source:z.string(),url:z.string().url().optional()}).parse(req.body);const source=sources().find(s=>s.id===v.source),p=getProduct(String(req.params.code));if(!source||!p||source.kind==='manual')throw new Error('Choose a browser/API source and an existing product');if(p.ownBrand)throw new Error('Own-brand products require store photography');
  try{assertSource(source);if(Date.now()-source.lastRequest<Math.max(1000,source.throttleMs))throw new Error('Source throttle active; wait before retrying');source.lastRequest=Date.now();saveSource(source);const adapter=adapterFor(source),leads=v.url?await adapter.getCandidates(v.url):await adapter.search(p,p.suggestedSearch);const saved=[];for(const lead of leads.slice(0,5))saved.push(await saveLead(p.code,lead,source));source.health=`Manual extraction returned ${saved.length} images (${now()})`;saveSource(source);event(p.code,'EXTRACTION',`${saved.length} images saved`,{source:source.id});res.json({count:saved.length,candidates:saved});}
  catch(e){failSource(source,e);throw e;}
});
app.post('/api/jobs',(req,res)=>{
  const v=z.object({codes:z.array(z.string()).max(20000).optional(),limit:z.union([z.literal('all'),z.number().int().min(1).max(20000)]).default(50),retry:z.boolean().default(false)}).parse(req.body);
  const rows=(v.codes?.length?v.codes:(db.prepare(`SELECT code FROM products WHERE workflow ${v.retry?"IN ('FAILED','NEEDS_STORE_PHOTO','AWAITING_REVIEW')":"IN ('IMPORTED','AWAITING_REVIEW')"} ORDER BY code LIMIT ?`).all(v.limit==='all'?20000:v.limit) as {code:string}[]).map(r=>r.code));res.json(enqueue(rows,v.retry));
});
app.post('/api/jobs/control',(req,res)=>res.json(queueControl(z.object({action:z.enum(['pause','resume','stop'])}).parse(req.body).action)));
app.get('/api/jobs',(_req,res)=>res.json({paused:getKV('queuePaused',false),worker:getKV('workerHeartbeat',null),rows:db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200').all()}));
app.post('/api/export',async(req,res)=>{const v=z.object({incremental:z.boolean().default(false),codes:z.array(z.string()).max(20000).optional()}).parse(req.body);res.json(await createExport(v.incremental,v.codes));});
app.get('/api/exports',(_req,res)=>res.json(db.prepare('SELECT id,body,created_at FROM exports ORDER BY created_at DESC LIMIT 50').all()));
app.get('/api/exports/:id',async(req,res)=>{uuid.parse(req.params.id);res.type('zip').attachment(`PackLens-${req.params.id}.zip`).send(await exportBytes(String(req.params.id)));});
app.get('/api/reports/:kind',(req,res)=>{
  const kind=z.enum(['review','photo','all','audit']).parse(req.params.kind);let rows:Record<string,unknown>[];
  if(kind==='audit')rows=db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string,unknown>[];
  else {const products=(db.prepare('SELECT body FROM products ORDER BY code').all() as {body:string}[]).map(r=>JSON.parse(r.body) as Product);rows=products.filter(p=>kind==='all'||kind==='photo'?kind==='all'||p.workflow==='NEEDS_STORE_PHOTO':['AWAITING_REVIEW','FAILED','REJECTED'].includes(p.workflow)).map(p=>({item_code:p.code,name:p.name,brand:p.brand,size:p.size,matching:p.matching,workflow:p.workflow,rights:p.rights,quality:p.quality,conflict:p.conflict,reviewer:p.reviewer,review_reason:p.reviewReason,source_sheet:p.sheet,source_row:p.row,barcodes:p.barcodeText}));}
  res.type('text/csv').attachment(`PackLens-${kind}.csv`).send(csv(rows));
});
app.get('/api/events',(req,res)=>{const q=String(req.query.q||'');res.json(db.prepare('SELECT * FROM events WHERE code LIKE ? OR message LIKE ? OR kind LIKE ? ORDER BY id DESC LIMIT 300').all(`%${q}%`,`%${q}%`,`%${q}%`));});
app.get('/api/visual',(_req,res)=>res.json(visualDashboard()));
app.get('/api/review-folders',(_req,res)=>res.json(reviewFolderDashboard()));
app.post('/api/review-folders/scan',async(_req,res)=>{if(!(db.prepare('SELECT count(*) n FROM review_files').get() as {n:number}).n)await initReviewFolders();res.json(await syncReviewFolders());});
app.post('/api/review-folders/open',async(_req,res)=>{if(!(db.prepare('SELECT count(*) n FROM review_files').get() as {n:number}).n)await initReviewFolders();const child=spawn('explorer.exe',[reviewRoot],{windowsHide:true,stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();res.json({root:reviewRoot});});
app.get('/api/review-folders/file/:id',(req,res)=>{const row=db.prepare("SELECT path FROM review_files WHERE candidate_id=? AND state IN ('PRESENT','MODIFIED')").get(String(req.params.id)) as {path:string}|undefined;if(!row)return res.sendStatus(404);const target=path.resolve(reviewRoot,row.path);if(!target.startsWith(reviewRoot+path.sep))return res.sendStatus(403);res.sendFile(target);});
app.post('/api/visual/status',async(_req,res)=>res.json(await refreshCodexStatus()));
app.patch('/api/visual/settings',(req,res)=>{const cfg=visualSettingsSchema.parse(req.body);setKV('visualSettings',cfg);event('','VISUAL_SETTINGS','Local Codex visual settings updated',cfg);res.json(cfg);});
app.post('/api/visual/queue',(req,res)=>{const v=z.object({candidateIds:z.array(uuid).max(50).optional(),pilotOnly:z.boolean().default(true),upgradeFallback:z.boolean().default(false)}).parse(req.body);res.json(enqueueVisual(v.candidateIds,v.pilotOnly,v.upgradeFallback));});
app.post('/api/automation/start',(req,res)=>{
  const v=z.object({limit:z.union([z.literal('all'),z.number().int().min(1).max(50)]).default(5),pilotOnly:z.boolean().default(true),codes:z.array(z.string()).max(50).optional()}).parse(req.body);
  for(const source of sources().filter(s=>['off','obf','opf'].includes(s.id))){source.enabled=true;source.accessAllowed=true;saveSource(source);}
  const cfg=visualDashboard().settings;setKV('visualSettings',{...cfg,enabled:true});setKV('autoVisualReview',true);setKV('browserFallbackEnabled',true);setKV('visualQueuePaused',false);
  const codes=v.codes?.length?v.codes:(db.prepare(`SELECT p.code FROM products p WHERE p.workflow IN ('IMPORTED','AWAITING_REVIEW','NEEDS_STORE_PHOTO') AND ${v.pilotOnly?"EXISTS (SELECT 1 FROM origins o WHERE o.code=p.code AND o.sheet='Pilot 50')":'1=1'} ORDER BY p.rowid LIMIT ?`).all(v.limit==='all'?50:v.limit) as {code:string}[]).map(r=>r.code);
  const result=enqueue(codes,true);event('','AUTOMATION_START','Name-based discovery and Codex verification started',{codes,source:'off',noProductUrlsRequired:true});res.json({...result,note:'Searches public authorized catalogs using Excel product names. Exact candidate verification follows automatically. Missing images, rights or uncertain packaging remain under review.'});
});
app.post('/api/visual/control',async(req,res)=>{const {action}=z.object({action:z.enum(['pause','resume','resume-codex'])}).parse(req.body);if(action==='resume-codex'){const status=await refreshCodexStatus();if(!status.available||status.limitReached||status.windows.some(w=>w.usedPercent>=visualDashboard().settings.pauseAtPercent))throw new Error(status.error||'Codex quota remains unavailable or at the pause threshold');setKV('visualCodexPaused','');}else setKV('visualQueuePaused',action==='pause');event('','VISUAL_CONTROL',action);res.json(visualDashboard());});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(existsSync(path.join(root,'dist','index.html'))){app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(root,'dist','index.html')));}
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const message=error instanceof Error?error.message:String(error);console.error(message);res.status(error instanceof z.ZodError?400:422).json({error:message});
});
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))app.listen(Number(process.env.PORT||4310),'127.0.0.1',()=>console.log(`PackLens: http://127.0.0.1:${process.env.PORT||4310}`));

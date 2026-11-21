import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {pilotInput} from '../tests/catalog-fixture.js';
process.env.PACKLENS_DATA_DIR=path.resolve('test-results/live-'+Date.now());
const {readBook,autoMap,importSheet}=await import('../src/importer.js');const {getProduct,sources,saveSource,db}=await import('../src/db.js');const {adapterFor,saveLead,failSource}=await import('../src/sources.js');
const book=await readBook(await pilotInput(),'optional-live-example.xlsx'),sheet=book.sheets.find(s=>s.name==='Pilot 50')!;importSheet(book,sheet.name,autoMap(sheet.headers),'optional-live-example.xlsx');const p=getProduct('202')!,s=sources().find(s=>s.id==='off')!;s.enabled=true;saveSource(s);
const result:any={privateWorkbook:!!process.env.PACKLENS_PILOT_FILE,exampleOnly:true,source:s.name,photos:[],errors:[]};
try{const leads=await adapterFor(s).search(p,p.productName);for(const lead of leads.slice(0,5)){try{const c=await saveLead(p.code,lead,s);result.photos.push({item:c.code,width:c.width,height:c.height,hash:c.hash,assessment:c.assessment,rights:c.rights});}catch(e){result.errors.push(String(e));failSource(s,e);if(s.blockedUntil>Date.now())break;}}}catch(e){failSource(s,e);result.errors.push(String(e));}
await mkdir('test-results',{recursive:true});await writeFile('test-results/optional-live-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));db.close();

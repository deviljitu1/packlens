import { readFile } from 'node:fs/promises';
import path from 'node:path';
const file=process.argv[2];if(!file)throw new Error('Pass the .xlsx or .csv path');
const base=`http://127.0.0.1:${process.env.PORT||4310}`;
async function call(url:string,body:unknown){const r=await fetch(base+url,body instanceof FormData?{method:'POST',body}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error);return result;}
const form=new FormData();form.append('file',new Blob([await readFile(file)]),path.basename(file));const preview=await call('/api/import/preview',form);
for(const sheet of preview.sheets){const result=await call('/api/import',{id:preview.id,sheet:sheet.name,mapping:sheet.mapping,flagged:/conflict|check first/i.test(sheet.name)});console.log(sheet.name,JSON.stringify(result));}
const response=await fetch(base+'/api/products');const result=await response.json();console.log('Unique products in the running application:',result.total);

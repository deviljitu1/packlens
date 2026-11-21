import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readBook, autoMap } from '../src/importer.js';
const files=process.argv.slice(2);if(!files.length){console.error('Usage: npm run inspect -- <catalog.xlsx or catalog.csv>');process.exit(1);}
for(const file of files){const book=await readBook(await readFile(file),path.basename(file));const result={filename:path.basename(file),sheets:book.sheets.map(s=>({name:s.name,rows:s.rows.filter(r=>Object.values(r).some(Boolean)).length,headers:s.headers,mapping:autoMap(s.headers),firstFive:s.rows.slice(0,5)})),instructions:book.instructions};await mkdir('test-results',{recursive:true});await writeFile(path.join('test-results',path.basename(file)+'.inspection.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}

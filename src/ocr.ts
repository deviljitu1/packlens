import { spawn } from 'node:child_process';
import sharp from 'sharp';
import path from 'node:path';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dataDir, uid } from './db.js';
import { normalize } from './matcher.js';
import { checkNames, type VisualResult } from './codex-client.js';
import type { Candidate, Product } from './types.js';
async function command(binary:string,args:string[]):Promise<string> {
  return new Promise((resolve,reject)=>{const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>{child.kill();reject(new Error('Local OCR timed out'));},30000);child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>500000)child.kill();});child.stderr.on('data',b=>{error=(error+b.toString()).slice(-500);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(new Error(error||`OCR exit ${code}`));});});
}
export async function localOCR(imagePath:string) {
  const tempDir=path.join(dataDir,'ocr');await mkdir(tempDir,{recursive:true});const temp=path.join(tempDir,uid()+'.png');
  await writeFile(temp,await sharp(imagePath).rotate().flatten({background:'#ffffff'}).resize(2400,2400,{fit:'inside',withoutEnlargement:true}).png().toBuffer());
  try {
    if(process.env.PACKLENS_TESSERACT_BIN)return await command(process.env.PACKLENS_TESSERACT_BIN,[temp,'stdout','--psm','11']);
    try{return await command('tesseract',[temp,'stdout','--psm','11']);}catch{/* Use built-in Windows OCR if Tesseract is absent. */}
    if(process.platform==='win32')return await command('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/windows-ocr.ps1',import.meta.url)),'-ImagePath',temp]);
    throw new Error('No local OCR engine available. Install Tesseract or use manual review.');
  }finally{await unlink(temp).catch(()=>{});}
}
export function ocrResult(p:Product,c:Candidate,text:string):VisualResult {
  const normalized=normalize(text);const checks=Object.fromEntries(checkNames.map(k=>[k,{state:'UNCERTAIN' as const,reason:'Local OCR cannot verify full packaging; manual visual review required'}])) as VisualResult['checks'];
  if(p.brand&&normalized.includes(normalize(p.brand)))checks.brand={state:'MATCH',reason:'Brand text found by local OCR; recognition can be imperfect'};
  const barcode=text.match(/\b\d{8,14}\b/g)?.find(b=>p.barcodes.includes(b))||'';
  return {candidateId:c.id,verdict:'UNCERTAIN',checks,visibleText:text,visibleBarcode:barcode,differences:[],reasons:[text?'Local OCR text saved. Full visual verification still required.':'OCR returned no legible text. Manual review required.']};
}

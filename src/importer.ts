import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { db, event, getKV,getProduct, now, saveProduct,setKV, transaction, uid } from './db.js';
import type { Product } from './types.js';
export const aliases: Record<string,string[]> = {
  code:['Item Code','Item Code (= file name)','SKU','ItemCode','Code'], name:['Our Item Name','Item Name','Title','Name'], brand:['Brand'], productName:['Product Name'], size:['Size','Pack Size'],
  barcodeText:['Barcode(s)','Barcode','EAN','GTIN'], department:['Department'], strategy:['Source Strategy'], suggestedSearch:['Suggested Search'], conflict:['Why','Reviewer Notes']
};
export type SheetData = { name: string; headers: string[]; rows: Record<string,string>[]; rowNumbers: number[] };
export type ParsedBook = { sheets: SheetData[]; instructions: { sheet: string; rows: string[][] }[] };
const normal = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g,'');
function cellText(cell: ExcelJS.Cell): string {
  const val = cell.value;
  if (val == null) return '';
  if (typeof val === 'object' && 'formula' in val) return val.result == null ? '' : String(val.result);
  if (typeof val === 'number') {
    const fmt = cell.numFmt;
    if (/^0+$/.test(fmt) && Number.isInteger(val)) return String(val).padStart(fmt.length,'0');
    return String(val);
  }
  return cell.text.trim();
}
export async function readBook(buffer: Buffer, filename: string): Promise<ParsedBook> {
  if (!/\.(xlsx|csv)$/i.test(filename)) throw new Error('Select an .xlsx or .csv file');
  const sheets: SheetData[] = [], instructions: ParsedBook['instructions'] = [];
  const add = (name: string, rows: string[][], numbers: number[]) => {
    let headerIndex = rows.findIndex(row => row.some(v => aliases.code.some(a=>normal(a)===normal(v))));
    if(headerIndex<0&&!/^(read|instructions|summary|by\s*brand)/i.test(name)){const possible=rows.findIndex(row=>row.filter(v=>v.trim()).length>=2);if(possible>=0&&rows.slice(possible+1).some(row=>row.filter(v=>v.trim()).length>=2))headerIndex=possible;}
    if (headerIndex < 0) { instructions.push({sheet:name,rows}); return; }
    const raw = rows[headerIndex];
    const seen = new Map<string,number>();
    const headers = raw.map((v,i)=> { const label = v || `Column ${i+1}`; const n=(seen.get(label)||0)+1;seen.set(label,n);return n===1?label:`${label} (${n})`; });
    sheets.push({name,headers,rows:rows.slice(headerIndex+1).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]||'']))),rowNumbers:numbers.slice(headerIndex+1)});
  };
  if (/\.csv$/i.test(filename)) {
    const rows = parse(buffer.toString('utf8').replace(/^\uFEFF/,''),{relax_column_count:true,skip_empty_lines:false}) as string[][];
    add('CSV',rows,rows.map((_,i)=>i+1));
  } else {
    // Some valid exporters prefix every SpreadsheetML element (x:workbook, x:sheet).
    // ExcelJS expects unprefixed element names. Normalize only that namespace in memory.
    const zip=await JSZip.loadAsync(buffer);let rewritten=false;
    const workbookXml=await zip.file('xl/workbook.xml')?.async('string');
    if(!workbookXml)throw new Error('Workbook XML is missing');
    if(/<(?:\w+:)workbook\b/.test(workbookXml)) {
      for(const entry of Object.values(zip.files).filter(e=>e.name.startsWith('xl/')&&e.name.endsWith('.xml'))) {
        let xml=await entry.async('string');const prefixes=[...xml.matchAll(/xmlns:([\w]+)=["']http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main["']/g)].map(m=>m[1]);
        for(const prefix of prefixes){xml=xml.replace(new RegExp(`(<\\/?)${prefix}:`,'g'),'$1').replace(new RegExp(`xmlns:${prefix}=`,'g'),'xmlns=');}
        if(prefixes.length){zip.file(entry.name,xml);rewritten=true;}
      }
    }
    const compatible=rewritten?await zip.generateAsync({type:'nodebuffer',compression:'STORE'}):buffer;
    const book = new ExcelJS.Workbook(); await book.xlsx.load(compatible as never);
    for (const s of book.worksheets) {
      const rows: string[][] = [], numbers: number[] = [],columnCount=s.columnCount;
      if(columnCount>200||s.rowCount>100001)throw new Error('Sheet exceeds the supported limit (100,000 rows / 200 columns)');
      s.eachRow({includeEmpty:true},(row,n)=> { const cells: string[]=[]; for(let c=1;c<=columnCount;c++) cells.push(cellText(row.getCell(c))); rows.push(cells);numbers.push(n); });
      add(s.name,rows,numbers);
    }
  }
  return {sheets,instructions};
}
export function autoMap(headers: string[]) { return Object.fromEntries(Object.entries(aliases).map(([key,names])=>[key,headers.find(h=>names.some(n=>normal(n)===normal(h)))||''])); }
export function safeCode(code: string) { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(code) && !code.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(code); }
export const barcodes = (text: string) => [...new Set(text.split(/[,;\n]/).map(v=>v.trim().replace(/[\s-]/g,'')).filter(Boolean))];
export function importSheet(book: ParsedBook, sheetName: string, mapping: Record<string,string>, filename: string, flagged = false) {
  const sheet = book.sheets.find(s=>s.name===sheetName); if (!sheet) throw new Error('Product sheet not found');
  if (!mapping.code || (!mapping.name && !mapping.productName)) throw new Error('Map item code and product name');
  for (const column of Object.values(mapping)) if (column && !sheet.headers.includes(column)) throw new Error(`Unknown mapped column: ${column}`);
  const id = uid(), errors: {row:number;error:string}[] = []; let added=0,updated=0,unchanged=0,blank=0;
  const knownOwnBrands=getKV<string[]>('ownBrands',[]);const instructionText=book.instructions.flatMap(s=>s.rows.flat()).join(' '),declaredOwnBrand=instructionText.match(/(?:our\s+)?own\s+brand\s*\(([^)]+)\)/i)?.[1]?.trim();if(declaredOwnBrand&&!knownOwnBrands.includes(declaredOwnBrand)){knownOwnBrands.push(declaredOwnBrand);setKV('ownBrands',knownOwnBrands);}
  const seen = new Set<string>();
  transaction(()=> {
    db.prepare('INSERT INTO imports VALUES (?,?,?,?)').run(id,filename,JSON.stringify({instructions:book.instructions,sheet:sheetName,mapping,flagged}),now());
    for (let i=0;i<sheet.rows.length;i++) {
      const original=sheet.rows[i], row=sheet.rowNumbers[i];
      if (Object.values(original).every(v=>!v.trim())) { blank++; continue; }
      const val=(field:string)=>String(original[mapping[field]]||'').trim(); const code=val('code');
      if (!safeCode(code)) { errors.push({row,error:`Invalid/missing item code: ${code}`});continue; }
      if (seen.has(code)) { errors.push({row,error:`Duplicate item code in sheet: ${code}. First row retained; original file preserved.`});continue; }
      seen.add(code);
      const name=val('name')||val('productName'); if (!name) {errors.push({row,error:`Missing product name for ${code}`});continue;}
      const conflict = (flagged || /conflict|check first/i.test(sheetName)) ? val('conflict')||'Existing packaging conflict: review required' : '';
      const ownBrand=knownOwnBrands.some(b=>b.toLowerCase()===val('brand').toLowerCase())||/own.brand photography/i.test(val('strategy'));
      const previous=getProduct(code);
      const fresh={code,name,brand:val('brand'),productName:val('productName')||name,size:val('size'),barcodeText:val('barcodeText'),barcodes:barcodes(val('barcodeText')),department:val('department'),strategy:val('strategy'),suggestedSearch:val('suggestedSearch')||[val('brand'),val('productName')||name,val('size')].filter(Boolean).join(' '),original,sheet:sheetName,row,importedAt:now(),conflict,ownBrand};
      const changed = previous && ['name','brand','productName','size','barcodeText'].some(k=>previous[k as keyof Product]!==fresh[k as keyof typeof fresh]);
      const reset=!previous||changed||Boolean(conflict&&!previous.conflict)||Boolean(ownBrand&&!previous.ownBrand);
      const p: Product = { ...(previous||{}), ...fresh, conflict:[...new Set([previous?.conflict,conflict].filter(Boolean))].join('; '),
        matching:reset?'NOT_ASSESSED':previous!.matching, workflow:reset?(ownBrand?'NEEDS_STORE_PHOTO':conflict?'AWAITING_REVIEW':'IMPORTED'):previous!.workflow,
        rights:reset?'UNVERIFIED':previous!.rights, quality:reset?'PENDING':previous!.quality, approvedCandidate:reset?null:previous!.approvedCandidate,
        reviewer:reset?'':previous!.reviewer,reviewReason:reset?'':previous!.reviewReason,updatedAt:now() };
      if(reset)p.approvedImages=[];
      p.catalogRole=previous?.catalogRole==='MAIN'||!(flagged||/conflict|check first/i.test(sheetName))?'MAIN':'CONFLICT_ONLY';
      saveProduct(p);
      db.prepare('INSERT INTO origins VALUES (?,?,?,?,?)').run(id,code,sheetName,row,JSON.stringify(original));
      if(!previous)added++;else if(changed)updated++;else unchanged++;
      if(changed)event(code,'IMPORT_CHANGED','Product identity changed; prior approval invalidated');
    }
    event('','IMPORT',`Imported ${sheetName}`,{id,added,updated,unchanged,blank,errors});
  });
  return {id,added,updated,unchanged,blank,errors,total:added+updated+unchanged,sourceHash:createHash('sha256').update(JSON.stringify(sheet)).digest('hex')};
}

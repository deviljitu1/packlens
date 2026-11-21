import type { Assessment, Candidate, Evidence, Product, Settings } from './types.js';
import { createHash } from 'node:crypto';
import { visualQualityFailures } from './quality.js';
export const normalize = (v:string) => v.toLowerCase().normalize('NFKD').replace(/multigrains/g,'multigrain').replace(/\bgm\b/g,'g').replace(/\blitres?\b/g,'l').replace(/[^a-z0-9.+/]+/g,' ').trim().replace(/\s+/g,' ');
function measures(v:string) { return [...normalize(v).matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/g)].map(m=>`${Number(m[1])*(m[2]==='kg'||m[2]==='l'?1000:1)}${m[2]==='kg'||m[2]==='g'?'g':'ml'}`); }
const special=['multigrain','sharbati','chakki','select','ganache','salt','pudina','peri','chocolate','vanilla','strawberry','lemon','rose','mint','gel','bar','liquid','powder','organic','red','blue','green','black','white','bottle','pouch','tin','jar','refill'];
function pack(v:string) { const n=normalize(v); return n.match(/(?:\bx\s*|pack of\s*)(\d+)/)?.[1]||n.match(/\b(\d+)\s*x\s*\d/)?.[1]||''; }
export function assess(p: Product, e: Evidence, cfg: Pick<Settings,'highThreshold'|'mediumThreshold'>): Assessment {
  const reasons:string[]=[], vetoes:string[]=[]; let score=0;
  const expected=normalize(`${p.productName} ${p.size}`), actual=normalize(`${e.title} ${e.variant} ${e.size}`);
  const expectedBrand=normalize(p.brand), candidateBrand=normalize(e.brand),brandMatches=e.brand.split(/[,;|]/).map(normalize).includes(expectedBrand);
  if(expectedBrand&&brandMatches){score+=.2;reasons.push('Brand metadata agrees');}
  else if(expectedBrand&&candidateBrand&&!brandMatches) vetoes.push('Brand mismatch');
  else reasons.push('Brand not independently confirmed');
  const tokens=normalize(p.productName).split(' ').filter(t=>t.length>2&&!expectedBrand.includes(t));
  const overlap=tokens.filter(t=>actual.split(' ').includes(t)).length/Math.max(1,tokens.length);score+=overlap*.3;
  if(overlap<.6) reasons.push('Product line/title has incomplete agreement');
  const pm=measures(p.size), cm=measures(e.size||e.title);
  if(pm.length===1&&cm.length&&pm[0]===cm[0]) {score+=.2;reasons.push('Declared size agrees');}
  else if(pm.length&&cm.length&&!pm.some(m=>cm.includes(m)))vetoes.push('Size mismatch');
  else reasons.push('Size unresolved or absent');
  if(/\//.test(p.size)) reasons.push('Original workbook has alternate sizes; manual resolution required');
  const ep=pack(`${p.size} ${p.name}`), cp=e.packCount||pack(actual);
  if(ep&&ep!==cp)vetoes.push('Pack count mismatch or unconfirmed multipack');
  if(!ep&&cp&&cp!=='1')vetoes.push('Unexpected multipack');
  const promo=/\bfree\b|\+/.test(expected), cpPromo=/\bfree\b|\+/.test(actual);
  if(promo!==cpPromo)vetoes.push('Promotional/free-pack mismatch');
  if(promo&&normalize(p.size)!==normalize(e.size))vetoes.push('Promotional quantities not exactly confirmed');
  if(ep&&pm.length>1&&normalize(p.size)!==normalize(e.size))vetoes.push('Multipack quantities not exactly confirmed');
  for(const token of special) if(expected.split(' ').includes(token)!==actual.split(' ').includes(token))vetoes.push(`Variant/form/colour differs or unconfirmed: ${token}`);
  const gtin=(v:string)=>v.replace(/^0+/,'');
  if(e.barcodeVerified&&e.barcode) {
    if(p.barcodes.some(b=>gtin(b)===gtin(e.barcode))) {score+=.1;reasons.push('Source confirms a supplied barcode');}
    else if(p.barcodes.length)vetoes.push('Source-confirmed barcode disagrees');
  }
  if(e.packagingVerified&&e.packagingNotes.trim()) {score+=.2;reasons.push('Packaging visually checked with recorded evidence');}
  else reasons.push('Packaging not visually verified; title alone cannot be HIGH');
  if(p.ownBrand && !e.packagingVerified)vetoes.push('Own brand requires store photograph and packaging verification');
  if(p.conflict)reasons.push(`Existing conflict requires human resolution: ${p.conflict}`);
  score=Math.min(1,Number(score.toFixed(3)));
  const highAllowed=!!expectedBrand&&pm.length===1&&!p.size.includes('/')&&!p.conflict&&e.packagingVerified&&!!e.packagingNotes&&overlap===1&&brandMatches&&cm.length===1&&pm[0]===cm[0];
  let category: Assessment['category']=vetoes.length?'LOW':score>=cfg.highThreshold&&highAllowed?'HIGH':score>=cfg.mediumThreshold?'MEDIUM':'LOW';
  if(!vetoes.length&&!highAllowed&&score>=cfg.mediumThreshold)category='MEDIUM';
  return {category,score,reasons,vetoes};
}
export const VISUAL_POLICY_VERSION='packlens-visual-3-quality-and-views';
export function verificationKey(p:Product,c:Candidate) { return createHash('sha256').update(JSON.stringify({policy:VISUAL_POLICY_VERSION,hash:c.hash,source:c.source,pageUrl:c.pageUrl,evidence:c.evidence,catalog:{code:p.code,name:p.name,brand:p.brand,productName:p.productName,size:p.size,barcodes:p.barcodes,conflict:p.conflict,ownBrand:p.ownBrand}})).digest('hex'); }
export function assessCandidate(p:Product,c:Candidate,cfg:Pick<Settings,'highThreshold'|'mediumThreshold'>):Assessment {
  const base=assess(p,c.evidence,cfg),v=c.visual;if(!v||v.fingerprint!==verificationKey(p,c))return base;
  const checks=Object.entries(v.checks);const mismatches=checks.filter(([,check])=>check.state==='MISMATCH');
  base.reasons.push(`${v.engine}: ${v.verdict}`,...v.reasons);
  base.vetoes.push(...visualQualityFailures(c));
  if(v.visibleBarcode&&/^\d{8,14}$/.test(v.visibleBarcode)) {
    const gtin=(s:string)=>s.replace(/^0+/,'');
    if(p.barcodes.length&&!p.barcodes.some(b=>gtin(b)===gtin(v.visibleBarcode)))base.vetoes.push('Visually transcribed barcode disagrees with supplied candidate barcodes; human confirmation required');
    else if(c.evidence.barcodeVerified&&c.evidence.barcode&&gtin(c.evidence.barcode)!==gtin(v.visibleBarcode))base.vetoes.push('Visual barcode disagrees with source-confirmed barcode');
    else base.reasons.push('Transcribed visible barcode agrees; model/OCR transcription remains reviewable');
  }
  if(mismatches.length||v.verdict==='MISMATCH'){base.vetoes.push(...mismatches.map(([key,check])=>`Visual ${key}: ${check.reason}`));if(!mismatches.length)base.vetoes.push('Visual reviewer reported a mismatch');base.category='LOW';return base;}
  if(base.vetoes.length){base.category='LOW';return base;}
  const q=v.imageQuality,qualityVerified=!!q&&q.textLegible==='YES'&&q.watermark==='NO'&&q.screenshot==='NO'&&q.importantLabelsCropped==='NO'&&q.artifacts==='NO'&&(!['FRONT','BACK'].includes(v.view?.kind||'UNKNOWN')||q.fullProductVisible==='YES');
  const allVerified=v.engine==='CODEX_CLI'&&v.verdict==='EXACT_MATCH'&&v.differences.length===0&&checks.length===7&&checks.every(([,check])=>check.state==='MATCH')&&qualityVerified;
  const strongCatalog=!!p.brand&&!!p.size&&!p.size.includes('/')&&!p.conflict;
  if(allVerified&&strongCatalog){base.score=Math.max(base.score,.96);base.category=base.score>=cfg.highThreshold?'HIGH':'MEDIUM';base.reasons.push('Visual checks agree; deterministic mismatch vetoes remain enforced');}
  else {base.category=base.score>=cfg.mediumThreshold?'MEDIUM':'LOW';base.reasons.push('Visual/OCR uncertainty requires human review; HIGH disallowed');}
  return base;
}

import {candidates,getProduct,saveCandidate,saveProduct,settings} from './db.js';
import {assessCandidate,verificationKey} from './matcher.js';
import type {Candidate,Product} from './types.js';
function cleanVisual(c:Candidate,p:Product){const v=c.visual,q=v?.imageQuality;return c.decision!=='REJECTED'&&v?.engine==='CODEX_CLI'&&v.fingerprint===verificationKey(p,c)&&q?.textLegible==='YES'&&q.watermark==='NO'&&q.screenshot==='NO'&&q.importantLabelsCropped==='NO'&&q.artifacts==='NO'&&(!['FRONT','BACK'].includes(v.view?.kind||'UNKNOWN')||q.fullProductVisible==='YES');}
/** Corroborate different views only when the actual source confirms one SKU/barcode. */
export function reassessProduct(code:string){
  const p=getProduct(code);if(!p)return;const list=candidates(code),cfg=settings();
  for(const c of list)c.assessment=assessCandidate(p,c,cfg);
  for(const c of list){
    if(!cleanVisual(c,p)||c.assessment.vetoes.length||!p.brand||!p.size||p.size.includes('/')||p.conflict||!c.evidence.barcodeVerified||!p.barcodes.includes(c.evidence.barcode)||!c.pageUrl)continue;
    const peers=list.filter(peer=>cleanVisual(peer,p)&&peer.source===c.source&&peer.pageUrl===c.pageUrl&&peer.evidence.barcodeVerified&&peer.evidence.barcode===c.evidence.barcode);
    if(peers.length<2)continue;
    if(peers.some(peer=>peer.assessment.vetoes.length||peer.visual!.verdict==='MISMATCH'||peer.visual!.differences.length)){c.assessment.category='LOW';c.assessment.vetoes.push('Inconsistent packaging among images associated with the same source SKU');continue;}
    const checks=['brand','productName','weight','variant','packagingText','packCount','promotion'];
    if(checks.some(key=>peers.some(peer=>peer.visual!.checks[key]?.state==='MISMATCH')))continue;
    if(checks.every(key=>peers.some(peer=>peer.visual!.checks[key]?.state==='MATCH'))){
      c.assessment.score=Math.max(c.assessment.score,.96);c.assessment.category=c.assessment.score>=cfg.highThreshold?'HIGH':'MEDIUM';
      c.assessment.reasons.push('Exact attributes corroborated across visually checked views of one source-confirmed barcode/SKU',...checks.map(key=>`${key} evidence: image ${peers.find(peer=>peer.visual!.checks[key]?.state==='MATCH')!.id}`));
    }
  }
  for(const c of list)saveCandidate(c);
  const ranking={HIGH:3,MEDIUM:2,LOW:1,NO_MATCH:0,SOURCE_BLOCKED:0,NOT_ASSESSED:0};const best=list.filter(c=>c.decision!=='REJECTED').sort((a,b)=>ranking[b.assessment.category]-ranking[a.assessment.category]||b.assessment.score-a.assessment.score)[0];
  if(best){p.matching=best.assessment.category;saveProduct(p);}
}

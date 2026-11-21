import type { ImageSelection, Product } from './types.js';
export function selections(p:Product):ImageSelection[]{return p.approvedImages|| (p.approvedCandidate?[{candidateId:p.approvedCandidate,slot:1,view:'FRONT'}]:[]);}
export const selected=(p:Product,id:string)=>selections(p).find(s=>s.candidateId===id);
export function removeSelection(p:Product,id:string){p.approvedImages=selections(p).filter(s=>s.candidateId!==id);p.approvedCandidate=p.approvedImages.find(s=>s.slot===1)?.candidateId||null;}
export function selectImage(p:Product,value:ImageSelection){
  if(value.slot<1||value.slot>5||value.slot===1&&value.view!=='FRONT'||value.slot===2&&value.view!=='BACK'||value.view==='UNKNOWN')throw new Error('Slots 1 and 2 require front and back. Choose a known view for slots 3–5.');
  p.approvedImages=[...selections(p).filter(s=>s.slot!==value.slot&&s.candidateId!==value.candidateId),value].sort((a,b)=>a.slot-b.slot);p.approvedCandidate=p.approvedImages.find(s=>s.slot===1)?.candidateId||null;
}

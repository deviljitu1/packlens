export type Matching = 'NOT_ASSESSED' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_MATCH' | 'SOURCE_BLOCKED';
export type Workflow = 'IMPORTED' | 'QUEUED' | 'SEARCHING' | 'CANDIDATES_FOUND' | 'AWAITING_REVIEW' | 'APPROVED' | 'REJECTED' | 'NEEDS_STORE_PHOTO' | 'ENHANCING' | 'READY_TO_EXPORT' | 'EXPORTED' | 'FAILED';
export type Rights = 'OWNED_PHOTO' | 'CONFIRMED_COMMERCIAL_USE' | 'UNVERIFIED' | 'PROHIBITED';
export type Quality = 'PENDING' | 'PASS' | 'WARNING' | 'FAIL';
export type ImageView = 'FRONT' | 'BACK' | 'NUTRITION' | 'FSSAI' | 'OTHER' | 'UNKNOWN';
export interface ImageSelection { candidateId:string;slot:number;view:ImageView; }
export interface Product {
  code: string; name: string; brand: string; productName: string; size: string; barcodeText: string; barcodes: string[]; department: string;
  strategy: string; suggestedSearch: string; original: Record<string, string>; sheet: string; row: number; importedAt: string;
  conflict: string; ownBrand: boolean; matching: Matching; workflow: Workflow; rights: Rights; quality: Quality;
  catalogRole?:'MAIN'|'CONFLICT_ONLY';
  approvedCandidate: string | null; reviewer: string; reviewReason: string; updatedAt: string;
  approvedImages?:ImageSelection[];
}
export interface Evidence {
  title: string; brand: string; size: string; variant: string; packCount: string; barcode: string; barcodeVerified: boolean;
  packagingVerified: boolean; packagingNotes: string; // Human observation, never inferred from a page title.
}
export interface Assessment { category: Matching; score: number; reasons: string[]; vetoes: string[]; }
export interface Candidate {
  id: string; code: string; source: string; pageUrl: string; imageUrl: string; evidence: Evidence; assessment: Assessment;
  rights: Rights; rightsEvidence: string; rightsReviewer: string; attribution: string;
  originalFile: string; hash: string; perceptualHash: string; width: number; height: number;
  decision: 'PENDING' | 'APPROVED' | 'REJECTED'; reviewedBy: string; reviewReason: string;
  finalFile: string; finalHash: string; settingsHash: string; quality: Quality; warnings: string[]; transforms: string[]; createdAt: string;
  view?:ImageView; viewVerified?:boolean; finalSlot?:number;
  qualityAnalysis?:{width:number;height:number;sharpness:number;entropy:number;failures:string[];warnings:string[]};
  visual?: {id:string;fingerprint:string;engine:'CODEX_CLI'|'LOCAL_OCR'|'MANUAL_REQUIRED';verdict:'EXACT_MATCH'|'MISMATCH'|'UNCERTAIN';checks:Record<string,{state:'MATCH'|'MISMATCH'|'UNCERTAIN'|'NOT_VISIBLE';reason:string}>;visibleText:string;visibleBarcode:string;differences:string[];reasons:string[];createdAt:string;fallbackReason:string;view?:{kind:ImageView;reason:string;detailsAvailable:string[]};imageQuality?:{fullProductVisible:'YES'|'NO'|'UNCERTAIN';textLegible:'YES'|'NO'|'UNCERTAIN';watermark:'YES'|'NO'|'UNCERTAIN';screenshot:'YES'|'NO'|'UNCERTAIN';importantLabelsCropped:'YES'|'NO'|'UNCERTAIN';artifacts:'YES'|'NO'|'UNCERTAIN';reason:string}};
}
export interface Settings {
  width: number; height: number; format: 'webp' | 'png' | 'jpeg'; quality: number; background: string; margin: number;
  sharpen: boolean; upscale: boolean; highThreshold: number; mediumThreshold: number; watchBrowser: boolean; autoApprove: boolean;
  requiredImages:number;
  removeBackground:boolean;aiUpscale:boolean;denoise:boolean;
  downloadOnly:boolean;
}
export interface Source {
  id: string; name: string; kind: 'off' | 'browser' | 'manual'; enabled: boolean; priority: number; accessAllowed: boolean;
  authorization: string; reuse: string; searchUrl: string; allowedHosts: string[]; imageSelector: string;
  throttleMs: number; timeoutMs: number; health: string; blockedUntil: number; lastRequest: number;
}
export const emptyEvidence: Evidence = { title: '', brand: '', size: '', variant: '', packCount: '', barcode: '', barcodeVerified: false, packagingVerified: false, packagingNotes: '' };

import { chromium, type Browser, type Page } from 'playwright';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { emptyEvidence, type Evidence, type ImageView, type Product, type Source } from './types.js';
import { addImage } from './images.js';
import { db,event, saveSource, settings } from './db.js';
import { assess } from './matcher.js';

export class SourceError extends Error { constructor(message:string, public kind:'BLOCKED'|'RATE_LIMIT'|'TIMEOUT'|'ACCESS'|'INVALID'|'NETWORK'|'UNAVAILABLE') {super(message);} }
const privateIP=(ip:string) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|224\.|255\.|::|fc|fd|fe80)/i.test(ip)||/^172\.(1[6-9]|2\d|3[01])\./.test(ip)||ip.includes('::ffff:');
export async function permittedUrl(raw:string,source:Source) {
  let u:URL;try{u=new URL(raw);}catch{throw new SourceError('Invalid source URL','INVALID');}
  const fixture=process.env.PACKLENS_TEST_MODE==='1'&&['127.0.0.1','localhost'].includes(u.hostname);
  if(u.username||u.password||(!fixture&&(u.protocol!=='https:'||!!u.port)))throw new SourceError('Only HTTPS on the standard port is permitted','ACCESS');
  if(!source.allowedHosts.includes(u.hostname))throw new SourceError(`Host is outside this source allowlist: ${u.hostname}`,'ACCESS');
  if(!fixture) {
    const records=isIP(u.hostname)?[{address:u.hostname}]:await lookup(u.hostname,{all:true});
    if(!records.length||records.some(r=>privateIP(r.address)))throw new SourceError('Private/local network destinations are not permitted','ACCESS');
  }
  return u;
}
export function assertSource(source:Source) {
  if(!source.enabled||!source.accessAllowed||!source.authorization.trim())throw new SourceError('Source disabled or access authorization missing','ACCESS');
  if(source.blockedUntil>Date.now())throw new SourceError(`Source paused: ${source.health}`,'BLOCKED');
}
function checkResponse(status:number,text='') {
  if(status===429)throw new SourceError('HTTP 429: rate limit; source paused','RATE_LIMIT');
  if(status===503)throw new SourceError('HTTP 503: service temporarily unavailable; source paused','UNAVAILABLE');
  if(status===403||status===401||/captcha|verify you are human|access denied|unusual traffic/i.test(text))throw new SourceError(`Blocked/access challenge (HTTP ${status}); source paused`,'BLOCKED');
  if(status>=400)throw new SourceError(`HTTP ${status}`,'NETWORK');
}
export async function safeFetch(raw:string,source:Source,accept='application/json') {
  assertSource(source);let target=raw;
  for(let redirects=0;redirects<4;redirects++) {
    await permittedUrl(target,source);
    let response:Response;try{response=await fetch(target,{headers:{'User-Agent':'PackLens/1.0 (local catalog review)','Accept':accept},redirect:'manual',signal:AbortSignal.timeout(source.timeoutMs)});}catch(e){throw new SourceError(String(e),'NETWORK');}
    if([301,302,303,307,308].includes(response.status)){target=new URL(response.headers.get('location')||'',target).href;continue;}
    checkResponse(response.status);return response;
  }
  throw new SourceError('Too many redirects','INVALID');
}
export async function fetchImage(url:string,source:Source) {
  const response=await safeFetch(url,source,'image/webp,image/png,image/jpeg');
  if(!/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type')||''))throw new SourceError('Image URL did not return JPEG, PNG or WebP MIME','INVALID');
  if(Number(response.headers.get('content-length')||0)>25*1024*1024)throw new SourceError('Image exceeds 25 MB','INVALID');
  const chunks:Uint8Array[]=[];let total=0;const reader=response.body!.getReader();
  try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>25*1024*1024)throw new SourceError('Image exceeds 25 MB','INVALID');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
export interface Lead {pageUrl:string;imageUrl:string;evidence:Evidence;attribution?:string;extractedBy:string;view?:ImageView;}
export interface SourceAdapter {
  search(product:Product,query:string):Promise<Lead[]>;
  getCandidates(url:string):Promise<Lead[]>;
  fetchImage(url:string):Promise<Buffer>;
  health():{status:string;blockedUntil:number};
  authorization():{accessAllowed:boolean;evidence:string;rights:string};
}
export abstract class BaseAdapter implements SourceAdapter {
  constructor(public source:Source){}
  abstract search(product:Product,query:string):Promise<Lead[]>;
  abstract getCandidates(url:string):Promise<Lead[]>;
  fetchImage(url:string){return fetchImage(url,this.source);}
  health(){return {status:this.source.health,blockedUntil:this.source.blockedUntil};}
  authorization(){return {accessAllowed:this.source.accessAllowed,evidence:this.source.authorization,rights:this.source.reuse};}
}
export class OpenFoodFactsAdapter extends BaseAdapter {
  private base(){return `https://${this.source.allowedHosts.find(h=>h.startsWith('world.'))||'world.openfoodfacts.org'}`;}
  private lead(row:Record<string,any>):Lead[] {
    let image=row.image_front_url||row.image_url;if(!image)return [];
    if(row.images?.front_en?.sizes?.full&&/\.\d+\.jpg$/.test(image))image=image.replace(/\.\d+\.jpg$/,'.full.jpg');
    const shared={pageUrl:row.url||`${this.base()}/product/${row.code}`,evidence:{...emptyEvidence,title:row.product_name||row.product_name_en||'',brand:row.brands||'',size:row.quantity||'',barcode:String(row.code||''),barcodeVerified:true},attribution:`${this.source.name} contributors. Image-specific license and attribution must be checked before commercial clearance.`};
    const lead:Lead[]=[{...shared,imageUrl:image,view:row.image_front_url?'FRONT':'UNKNOWN',extractedBy:'Public API selected front image'}];
    const used=new Set<string>();const frontKey=image.match(/\/(front_[a-z]+)\./)?.[1];if(frontKey&&row.images?.[frontKey]?.imgid)used.add(String(row.images[frontKey].imgid));
    const directory=new URL('.',image).href;
    const selected=Object.entries(row.images||{}).filter(([key,value])=>/^(ingredients|nutrition|packaging)_/.test(key)&&!!(value as any)?.imgid).sort(([a],[b])=>Number(a.startsWith('nutrition'))-Number(b.startsWith('nutrition')));
    for(const [key,value] of selected){const data=value as any,imgid=String(data.imgid);if(used.has(imgid)||!row.images?.[imgid]?.sizes?.full)continue;used.add(imgid);lead.push({...shared,imageUrl:directory+imgid+'.jpg',view:key.startsWith('ingredients')?'BACK':key.startsWith('nutrition')?'NUTRITION':'OTHER',extractedBy:`Public API ${key} original photo ${imgid}; view is a hint until visually verified`});}
    for(const [key,value] of Object.entries(row.images||{}).filter(([key,value])=>/^\d+$/.test(key)&&!!(value as any)?.sizes?.full).sort(([a],[b])=>Number(b)-Number(a))){if(used.has(key))continue;used.add(key);lead.push({...shared,imageUrl:directory+key+'.jpg',view:'UNKNOWN',extractedBy:`Public API original photo ${key}; view requires visual verification`});}
    return [...new Map(lead.map(l=>[l.imageUrl,l])).values()].slice(0,15);
  }
  async search(p:Product,query:string) {
    // Exactly one query per item. Global throttle enforced by the worker (minimum seven seconds).
    const url=`${this.base()}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=5&fields=code,product_name,product_name_en,brands,quantity,image_front_url,image_url,url,images`;
    const response=await safeFetch(url,this.source);const data=await response.json();
    const excluded=new Set((db.prepare('SELECT image_url FROM image_rejections WHERE code=?').all(p.code) as {image_url:string}[]).map(r=>r.image_url));
    if(db.prepare("SELECT 1 FROM replacement_requests WHERE code=? AND status IN ('QUEUED','SEARCHING','WAITING_SOURCE')").get(p.code))for(const row of db.prepare('SELECT body FROM candidates WHERE code=?').all(p.code) as {body:string}[])excluded.add(JSON.parse(row.body).imageUrl);
    const groups=(data.products||[]).map((row:Record<string,any>)=>{const leads=this.lead(row).filter(l=>!excluded.has(l.imageUrl)).slice(0,5);return {leads,assessment:leads[0]?assess(p,leads[0].evidence,settings()):null};}).filter((g:any)=>g.leads.length);
    groups.sort((a:any,b:any)=>Number(!!a.assessment.vetoes.length)-Number(!!b.assessment.vetoes.length)||b.assessment.score-a.assessment.score);
    return groups[0]?.leads||[]; // Five views from one source SKU, never a gallery mixing different packs.
  }
  async getCandidates(url:string) {
    const u=await permittedUrl(url,this.source);const code=u.pathname.match(/(?:product\/)?(\d{8,14})/)?.[1];if(!code)throw new SourceError('Open Food Facts URL needs a product barcode','INVALID');
    const response=await safeFetch(`${this.base()}/api/v2/product/${code}.json`,this.source);const data=await response.json();return data.product?this.lead(data.product).slice(0,5):[];
  }
}
export class BrowserAdapter extends BaseAdapter {
  constructor(source:Source,private options:{visible?:boolean;preferChrome?:boolean}={}){super(source);}
  async search(_p:Product,query:string){
    if(!this.source.searchUrl.includes('{query}'))throw new SourceError('Configure an authorized search URL with {query}','ACCESS');
    return this.getCandidates(this.source.searchUrl.replaceAll('{query}',encodeURIComponent(query)));
  }
  async getCandidates(url:string):Promise<Lead[]> {
    assertSource(this.source);await permittedUrl(url,this.source);let browser:Browser|undefined;
    try {
      const launch={headless:!(this.options.visible??settings().watchBrowser)};
      browser=this.options.preferChrome?await chromium.launch({...launch,channel:'chrome'}).catch(()=>chromium.launch(launch)):await chromium.launch(launch);
      const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,userAgent:'PackLens/1.0 permitted catalog review'});
      // tsx preserves function names with this helper inside serialized browser callbacks.
      await context.addInitScript({content:'globalThis.__name = (value) => value;'});
      await context.route('**/*',async route=>{
        try {if(route.request().method()!=='GET')return await route.abort();await permittedUrl(route.request().url(),this.source);await route.continue();}catch{await route.abort();}
      });
      const page=await context.newPage();page.setDefaultTimeout(this.source.timeoutMs);
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:this.source.timeoutMs});
      checkResponse(response?.status()||0,await page.locator('body').innerText({timeout:5000}).catch(()=>''));
      await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(800);
      const leads=await extractPage(page,this.source.imageSelector);
      event('','BROWSER_EXTRACT',`${leads.length} image leads extracted`,{url,methods:leads.map(l=>l.extractedBy)});
      return leads;
    }catch(e){if(e instanceof SourceError)throw e;throw new SourceError(String(e),/timeout/i.test(String(e))?'TIMEOUT':'NETWORK');}
    finally{await browser?.close();}
  }
}
export async function extractPage(page:Page,selector=''):Promise<Lead[]> {
  return page.evaluate(({selector})=>{
    const products:any[]=[];
    const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}if(v['@type']==='Product'||Array.isArray(v['@type'])&&v['@type'].includes('Product'))products.push(v);if(v['@graph'])visit(v['@graph']);if(v.mainEntity)visit(v.mainEntity);if(v.itemListElement)visit(v.itemListElement);if(v.item)visit(v.item);};
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{try{visit(JSON.parse(s.textContent||''));}catch{}});
    const product=products[0]||{},title=product.name||document.querySelector('h1')?.textContent||document.title;
    const brand=typeof product.brand==='string'?product.brand:product.brand?.name||'';
    const evidence={title:String(title).trim(),brand:String(brand),size:typeof product.size==='string'?product.size:'',variant:'',packCount:'',barcode:String(product.gtin13||product.gtin14||product.gtin||''),barcodeVerified:!!(product.gtin13||product.gtin14||product.gtin),packagingVerified:false,packagingNotes:''};
    const rows:{url:string;method:string}[]=[];const add=(url:any,method:string)=>{if(typeof url==='object')url=url?.url||url?.contentUrl;if(typeof url==='string'&&url.trim())try{const full=new URL(url,location.href).href;if(/^https?:/.test(full))rows.push({url:full,method});}catch{}};
    const structured=Array.isArray(product.image)?product.image:[product.image];structured.forEach((u:any)=>add(u,'JSON-LD Product.image'));
    if(!products.length&&!selector)return []; // Do not mistake a search-results page for a product page.
    const images=document.querySelectorAll<HTMLImageElement>(selector||'main img, article img, img[itemprop="image"]');
    images.forEach(img=>{
      const set=img.getAttribute('srcset')||img.closest('picture')?.querySelector('source')?.getAttribute('srcset')||'';
      const best=set.split(',').map(s=>s.trim().split(/\s+/)).filter(s=>s[0]).sort((a,b)=>parseFloat(b[1]||'0')-parseFloat(a[1]||'0'))[0];
      if(best)add(best[0],'img/srcset or picture/source');add(img.dataset.src,'img data-src');add(img.currentSrc||img.src,'img currentSrc/src');
    });
    add(document.querySelector('meta[property="og:image"]')?.getAttribute('content'),'og:image');
    const unique=[...new Map(rows.map(r=>[r.url,r])).values()].slice(0,5);
    return unique.map(r=>({pageUrl:location.href,imageUrl:r.url,evidence,extractedBy:r.method}));
  },{selector});
}
export const adapterFor=(s:Source):SourceAdapter=>s.kind==='off'?new OpenFoodFactsAdapter(s):new BrowserAdapter(s);
export function failSource(s:Source,e:unknown) {
  const error=e instanceof SourceError?e:new SourceError(String(e),'NETWORK');
  if(s.blockedUntil>Date.now()&&/^Source paused:/.test(error.message))return;
  if(['BLOCKED','RATE_LIMIT'].includes(error.kind))s.blockedUntil=Date.now()+60*60*1000;
  if(error.kind==='UNAVAILABLE')s.blockedUntil=Date.now()+15*60*1000;
  s.health=`${error.kind}: ${error.message.slice(0,400)}`;saveSource(s);event('','SOURCE_ERROR',s.health,{source:s.id,blockedUntil:s.blockedUntil});
}
export async function saveLead(code:string,lead:Lead,source:Source) {
  const buffer=await adapterFor(source).fetchImage(lead.imageUrl);
  return addImage(code,buffer,{source:source.id,pageUrl:lead.pageUrl,imageUrl:lead.imageUrl,evidence:lead.evidence,attribution:lead.attribution,rights:'UNVERIFIED',view:lead.view});
}

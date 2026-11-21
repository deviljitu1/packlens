import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candidate, Product, Settings, Source } from './types.js';

const requestedDir=path.resolve(process.env.PACKLENS_DATA_DIR || 'data');mkdirSync(requestedDir,{recursive:true});
export const dataDir = realpathSync(requestedDir);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.browsers');
for (const folder of ['db', 'originals', 'enhanced', 'exports', 'logs', 'imports', 'fixtures', 'browser']) mkdirSync(path.join(dataDir, folder), { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'db', 'studio.sqlite'), { timeout: 10000 });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, size TEXT NOT NULL, department TEXT NOT NULL, matching TEXT NOT NULL, workflow TEXT NOT NULL, rights TEXT NOT NULL, quality TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS products_workflow ON products(workflow);
CREATE INDEX IF NOT EXISTS products_matching ON products(matching);
CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES products(code), hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(code,hash));
CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, filename TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS origins (import_id TEXT NOT NULL REFERENCES imports(id), code TEXT NOT NULL REFERENCES products(code), sheet TEXT NOT NULL, row_number INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(import_id,sheet,row_number));
CREATE INDEX IF NOT EXISTS origins_code ON origins(code);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES products(code), status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_active ON tasks(code) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exported_assets (code TEXT NOT NULL, candidate_id TEXT NOT NULL, hash TEXT NOT NULL, settings_hash TEXT NOT NULL, export_id TEXT NOT NULL, PRIMARY KEY(code,candidate_id,hash,settings_hash));
CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_retries (code TEXT PRIMARY KEY,due_at INTEGER NOT NULL,attempts INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS image_rejections (code TEXT NOT NULL,hash TEXT NOT NULL,image_url TEXT NOT NULL,view TEXT NOT NULL,sequence INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(code,hash));
CREATE TABLE IF NOT EXISTS replacement_requests (id TEXT PRIMARY KEY,code TEXT NOT NULL,sequence INTEGER NOT NULL,view TEXT NOT NULL,old_candidate TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
`);
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export function transaction<T>(fn: () => T): T { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
export function getKV<T>(key: string, fallback: T): T { const row = db.prepare('SELECT body FROM kv WHERE key=?').get(key) as { body: string } | undefined; return row ? JSON.parse(row.body) : fallback; }
export function setKV(key: string, value: unknown) { db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value)); }
export const defaultSettings: Settings = { width: 640, height: 640, format: 'webp', quality: 90, background: '#FFFDF7', margin: 24, sharpen: false, upscale: false, highThreshold: .95, mediumThreshold: .7, watchBrowser: false, autoApprove: false,requiredImages:5,removeBackground:false,aiUpscale:false,denoise:false,downloadOnly:true };
export const settings = () => ({...defaultSettings,...getKV<Partial<Settings>>('settings',{})});
export function getProduct(code: string): Product | undefined { const row = db.prepare('SELECT body FROM products WHERE code=?').get(code) as { body: string } | undefined; return row ? JSON.parse(row.body) : undefined; }
export function saveProduct(p: Product) { p.updatedAt = now(); db.prepare(`INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,brand=excluded.brand,size=excluded.size,department=excluded.department,matching=excluded.matching,workflow=excluded.workflow,rights=excluded.rights,quality=excluded.quality,body=excluded.body`).run(p.code,p.name,p.brand,p.size,p.department,p.matching,p.workflow,p.rights,p.quality,JSON.stringify(p)); }
export function candidates(code: string): Candidate[] { return (db.prepare('SELECT body FROM candidates WHERE code=? ORDER BY rowid DESC').all(code) as { body: string }[]).map(r => JSON.parse(r.body)); }
export function getCandidate(id: string): Candidate | undefined { const row = db.prepare('SELECT body FROM candidates WHERE id=?').get(id) as { body: string } | undefined; return row ? JSON.parse(row.body) : undefined; }
export function saveCandidate(c: Candidate) { db.prepare('INSERT INTO candidates VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(c.id,c.code,c.hash,JSON.stringify(c)); }
export function sources(): Source[] { return (db.prepare('SELECT body FROM sources').all() as { body: string }[]).map(r=>JSON.parse(r.body)).sort((a,b)=>a.priority-b.priority); }
export function saveSource(s: Source) { db.prepare('INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(s.id,JSON.stringify(s)); }
export function event(code: string, kind: string, message: string, body: unknown = {}) { db.prepare('INSERT INTO events(code,kind,message,body,created_at) VALUES (?,?,?,?,?)').run(code,kind,message,JSON.stringify(body),now()); }
if (!sources().length) {
  const base = { enabled: false, accessAllowed: false, authorization: '', reuse: 'Per-image rights review required', searchUrl: '', allowedHosts: [], imageSelector: '', throttleMs: 7000, timeoutMs: 25000, health: 'Not tested', blockedUntil: 0, lastRequest: 0 };
  saveSource({ ...base, id: 'owned', name: 'Your store photographs', kind: 'manual', enabled: true, accessAllowed: true, authorization: 'User uploads; confirm ownership per image', priority: 0, health: 'Upload available' });
  saveSource({ ...base, id: 'off', name: 'Open Food Facts', kind: 'off', accessAllowed: true, authorization: 'Public API. https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/', allowedHosts: ['world.openfoodfacts.org','images.openfoodfacts.org'], priority: 10 });
  saveSource({ ...base, id: 'supplier', name: 'Authorized supplier / brand website', kind: 'browser', priority: 20 });
  for (const [i,name] of ['Amazon','Flipkart','JioMart','DMart Ready','BigBasket','Blinkit'].entries()) saveSource({ ...base, id: name.toLowerCase().replace(/\s/g,''), name, kind: 'browser', priority: 100+i, health: 'Disabled: authorization and permitted reuse not established' });
}
for(const [id,name,domain,priority] of [['obf','Open Beauty Facts','openbeautyfacts.org',11],['opf','Open Products Facts','openproductsfacts.org',12]] as const)if(!sources().some(s=>s.id===id))saveSource({id,name,kind:'off',enabled:false,priority,accessAllowed:true,authorization:'Public catalog API documented at https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/scanning-cosmetics-pet-food-and-other-products/',reuse:'Per-image rights and license review required',searchUrl:'',allowedHosts:[`world.${domain}`,`images.${domain}`,'images.openfoodfacts.org'],imageSelector:'',throttleMs:10000,timeoutMs:25000,health:'Not live-tested; experimental public catalog',blockedUntil:0,lastRequest:0});
db.exec(`UPDATE products SET body=json_set(body,'$.catalogRole',CASE WHEN EXISTS (SELECT 1 FROM origins o WHERE o.code=products.code AND o.sheet NOT IN ('Check first','Existing conflicts')) THEN 'MAIN' ELSE 'CONFLICT_ONLY' END) WHERE json_extract(body,'$.catalogRole') IS NULL;`);

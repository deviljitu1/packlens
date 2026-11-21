import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=process.argv[2]&&path.resolve(process.argv[2]);
if(!destination){console.error('Usage: node scripts/create-project.mjs <empty destination folder>');process.exit(1);}
if(destination===source||destination.startsWith(source+path.sep)&&['data','node_modules','.git'].includes(path.relative(source,destination).split(path.sep)[0]))throw new Error('Choose a separate application folder, not a private runtime directory');
await fs.mkdir(destination,{recursive:true});const existing=(await fs.readdir(destination)).filter(n=>n!=='.git');if(existing.length)throw new Error('Destination is not empty. Existing files have been preserved.');
const rootFiles=['SKILL.md','README.md','LICENSE','.gitignore','.env.example','package.json','package-lock.json','tsconfig.json','vite.config.ts','vitest.config.ts','index.html','start.bat','start.ps1'];
const scripts=['launch.ts','setup-browser.ts','windows-ocr.ps1','import-workbook.ts','automate.ts','inspect.ts','e2e.ts','test-live.ts','codex-status.ts','review-folders.ts','enable-download-only.ts','create-project.mjs'];
const docs=['ARCHITECTURE.md','API.md','SOURCE_POLICY.md','TEST_RESULTS.md','WORKBOOK_MAPPING.md'];
for(const file of rootFiles)await fs.copyFile(path.join(source,file),path.join(destination,file));
for(const dir of ['src','tests'])await fs.cp(path.join(source,dir),path.join(destination,dir),{recursive:true,errorOnExist:true,force:false});
for(const [dir,files] of [['scripts',scripts],['docs',docs]]){await fs.mkdir(path.join(destination,dir),{recursive:true});for(const file of files)await fs.copyFile(path.join(source,dir,file),path.join(destination,dir,file));}
console.log(`Created PackLens at ${destination}. No catalogs, images, database, credentials or model weights copied.`);

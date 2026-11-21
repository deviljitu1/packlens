import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const dev=process.argv.includes('--dev');
if(Number(process.versions.node.split('.')[0])<24){console.error('Install Node.js 24 LTS or newer.');process.exit(1);}
if(!dev&&!existsSync('dist/index.html')){console.error('Run npm run build first, or use start.bat.');process.exit(1);}
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.browsers');
const children=[spawn(process.execPath,['--import','tsx','src/server.ts'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,['--import','tsx','src/worker.ts'],{stdio:'inherit',windowsHide:true})];
children.push(spawn(process.execPath,['--import','tsx','src/visual-worker.ts'],{stdio:'inherit',windowsHide:true}));
children.push(spawn(process.execPath,['--import','tsx','src/review-worker.ts'],{stdio:'inherit',windowsHide:true}));
if(dev)children.push(spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit',windowsHide:true}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');setTimeout(()=>process.exit(0),1500).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const c of children)c.on('exit',code=>{if(!stopping&&code!==0){console.error('An application process exited. See error above.');stop();process.exitCode=code||1;}});
const url=dev?'http://127.0.0.1:5173':`http://127.0.0.1:${process.env.PORT||4310}`;
console.log(`\nOpen ${url}\nKeep this window open. Close dashboard tabs freely. Ctrl+C stops the app.\n`);
if(process.argv.includes('--open'))setTimeout(()=>{spawn('explorer.exe',[url],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});},1500);

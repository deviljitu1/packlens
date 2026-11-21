import { spawnSync } from 'node:child_process';
import path from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.browsers');
const result=spawnSync(process.execPath,['node_modules/playwright/cli.js','install','chromium'],{stdio:'inherit',env:process.env,windowsHide:true});process.exit(result.status??1);

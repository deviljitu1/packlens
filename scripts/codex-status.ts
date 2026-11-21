import { readCodexStatus } from '../src/codex-client.js';
console.log(JSON.stringify(await readCodexStatus(),null,2));

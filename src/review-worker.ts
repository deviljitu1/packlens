import { setTimeout as sleep } from 'node:timers/promises';
import { initReviewFolders,syncReviewFolders } from './review-folders.js';
import { db,event,setKV,now } from './db.js';
let quitting=false;process.on('SIGINT',()=>{quitting=true;});process.on('SIGTERM',()=>{quitting=true;});
if(!(db.prepare('SELECT count(*) n FROM review_files').get() as {n:number}).n)await initReviewFolders();console.log('Review-folder worker running. Delete a candidate file to queue a different replacement.');
while(!quitting){try{await syncReviewFolders();setKV('reviewWorkerHeartbeat',{at:now(),pid:process.pid});}catch(e){event('','REVIEW_WORKER_ERROR',String(e));}await sleep(5000);}

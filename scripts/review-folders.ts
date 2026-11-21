import { initReviewFolders,reviewFolderDashboard,syncReviewFolders } from '../src/review-folders.js';
import { db } from '../src/db.js';
if(!(db.prepare('SELECT count(*) n FROM review_files').get() as {n:number}).n)await initReviewFolders();
console.log(await syncReviewFolders());console.log(JSON.stringify(reviewFolderDashboard(),null,2));db.close();

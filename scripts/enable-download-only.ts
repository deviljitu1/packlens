import {db,event,setKV,settings} from '../src/db.js';
import {initReviewFolders,syncReviewFolders,reviewFolderDashboard} from '../src/review-folders.js';
setKV('settings',{...settings(),downloadOnly:true,removeBackground:false,aiUpscale:false,denoise:false,sharpen:false,upscale:false});
// Only creates missing directories during the initial inventory setup.
if(!(db.prepare('SELECT count(*) n FROM review_files').get() as {n:number}).n)await initReviewFolders();
event('','DOWNLOAD_ONLY','Original file bytes/formats preserved; image alteration disabled');console.log(await syncReviewFolders());console.log(JSON.stringify(reviewFolderDashboard(),null,2));db.close();

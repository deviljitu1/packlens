/** Read-only analysis is available; this download skill does not alter images. */
export function localCapabilities(){return {downloadOnly:true,imageEditing:false,backgroundRemoval:false,aiUpscale:false,ocr:process.platform==='win32'||!!process.env.PACKLENS_TESSERACT_BIN,blurDetection:true,watermarkDetection:'Codex visual review and OCR heuristics',concurrency:1};}
export async function localImageTool(_operation:'background'|'upscale',_input:Buffer):Promise<Buffer>{throw new Error('Image alteration is disabled. PackLens preserves original source bytes.');}

import sharp from 'sharp';
import type { Candidate } from './types.js';
export async function analyzeImage(buffer:Buffer){
  const meta=await sharp(buffer,{limitInputPixels:60_000_000}).metadata();
  const stats=await sharp(buffer).rotate().flatten({background:'#ffffff'}).resize(1000,1000,{fit:'inside',withoutEnlargement:true}).stats();
  const warnings:string[]=[],failures:string[]=[];
  const width=meta.width||0,height=meta.height||0;
  if(Math.max(width,height)<800||Math.min(width,height)<400)failures.push('Source is below the internet-image quality floor (800 px long edge, 400 px short edge). No artificial upscale substitution.');
  if(stats.entropy<.25||stats.sharpness<.15)failures.push('Image is blank or has too little usable detail');
  else if(stats.sharpness<1)warnings.push('Low measured sharpness; verify readable packaging text');
  if(Math.max(width,height)/Math.max(1,Math.min(width,height))>5)warnings.push('Unusual aspect ratio; verify the whole pack or panel is visible');
  return {width,height,sharpness:stats.sharpness,entropy:stats.entropy,failures,warnings};
}
export function visualQualityFailures(c:Candidate){
  const q=c.visual?.imageQuality;if(!q||c.visual?.engine!=='CODEX_CLI')return [];
  const failures:string[]=[];
  for(const k of ['watermark','screenshot','importantLabelsCropped','artifacts'] as const)if(q[k]==='YES')failures.push(`Codex image quality: ${k}`);
  if(['FRONT','BACK'].includes(c.view||'')&&q.fullProductVisible==='NO')failures.push('Full front/back pack is not visible');
  if(q.textLegible==='NO')failures.push('Packaging text is unreadable');
  return failures;
}

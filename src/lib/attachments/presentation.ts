import type { Attachment } from "@/types/attachment";
/** Runtime JSON can outlive old schemas; a bad entry must not crash the card. */
export function attachmentPresentation(value: unknown): Attachment[] {
 if(!Array.isArray(value))return[];
 return value.flatMap(entry=>{
  if(!entry||typeof entry!=="object"||Array.isArray(entry))return[];
  const {url,name,size,mime,width,height}=entry;
  if(typeof url!=="string"||!url||typeof name!=="string"||typeof size!=="number"||!Number.isFinite(size)||size<0||typeof mime!=="string")return[];
  return [{url,name,size,mime,...(typeof width==="number"&&Number.isFinite(width)&&width>0?{width}:{}),...(typeof height==="number"&&Number.isFinite(height)&&height>0?{height}:{})}];
 });
}
export function isAttachmentImage(mime: unknown): boolean {return typeof mime==="string"&&mime.startsWith("image/");}

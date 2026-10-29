/** Browser-only still-image preparation. Original files are the safe fallback. */
export const MAX_IMAGE_EDGE = 2560;
const QUALITY = 0.85;

function imageMime(file: File): string {
  if (file.type) return file.type.toLowerCase();
  return ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp"} as Record<string,string>)[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "";
}
export function isAnimatedImage(bytes: Uint8Array, mime: string): boolean {
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 8 && ascii(1,3) === "PNG") {
    for (let offset=8; offset+12<=bytes.length;) {
      const length=view.getUint32(offset,false), kind=ascii(offset+4,4);
      if(kind==="acTL") return true;
      if(length>bytes.length-offset-12) break;
      offset+=length+12;
    }
  }
  if (mime === "image/webp" && bytes.length>=12 && ascii(0,4)==="RIFF" && ascii(8,4)==="WEBP") {
    for(let offset=12;offset+8<=bytes.length;) {
      const kind=ascii(offset,4),length=view.getUint32(offset+4,true);
      if(kind==="ANIM"||kind==="ANMF"||(kind==="VP8X"&&length>=1&&offset+8<bytes.length&&(bytes[offset+8]&2)!==0)) return true;
      if(length>bytes.length-offset-8) break;
      offset+=8+length+(length%2);
    }
  }
  return false;
}
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; dispose: () => void }> {
  if(typeof createImageBitmap === "function") {
    const bitmap=await createImageBitmap(file);
    return {source:bitmap,width:bitmap.width,height:bitmap.height,dispose:()=>bitmap.close()};
  }
  const url=URL.createObjectURL(file), image=new Image();
  try {
    const loaded=new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error("IMAGE_DECODE_FAILED"));});
    image.src=url;await loaded;
    return {source:image,width:image.naturalWidth,height:image.naturalHeight,dispose:()=>{image.src="";URL.revokeObjectURL(url);}};
  } catch {URL.revokeObjectURL(url);throw new Error("IMAGE_DECODE_FAILED");}
}
export async function prepareImageForUpload(file: File): Promise<File> {
  const mime=imageMime(file);
  if(!["image/jpeg","image/png","image/webp"].includes(mime)) return file;
  let decoded: Awaited<ReturnType<typeof decode>> | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    if(isAnimatedImage(new Uint8Array(await file.arrayBuffer()),mime)) return file;
    decoded=await decode(file);
    if(!decoded.width||!decoded.height) return file;
    const scale=Math.min(1,MAX_IMAGE_EDGE/Math.max(decoded.width,decoded.height));
    canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(decoded.width*scale));canvas.height=Math.max(1,Math.round(decoded.height*scale));
    const context=canvas.getContext("2d");if(!context) return file;
    context.drawImage(decoded.source,0,0,canvas.width,canvas.height);
    // Retain the original format: PNG/WebP alpha is never flattened to JPEG.
    const blob=await new Promise<Blob|null>(resolve=>canvas!.toBlob(resolve,mime,QUALITY));
    if(!blob||blob.type!==mime||blob.size>=file.size) return file;
    return new File([blob],file.name,{type:mime,lastModified:file.lastModified});
  } catch {return file;} finally {decoded?.dispose();if(canvas){canvas.width=0;canvas.height=0;}}
}
/** Process sequentially; never retain several full-resolution decoded canvases. */
export async function prepareImagesForUpload(files: readonly File[]): Promise<File[]> {
  const prepared:File[]=[];for(const file of files) prepared.push(await prepareImageForUpload(file));return prepared;
}

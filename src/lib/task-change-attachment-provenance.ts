/** Exact new metadata only; a historical count never identifies a readable file. */
export function visibleAttachmentProvenanceCount(value:unknown,visibleUrls:ReadonlySet<string>):number {
 if(!value||typeof value!=="object"||Array.isArray(value))return 0;
 if((value as {discussionDraft?:unknown}).discussionDraft===true)return 0;
 const refs=(value as {files?:unknown}).files;
 if(!Array.isArray(refs)||!refs.length||refs.length>100||!refs.every(ref=>ref&&typeof ref==="object"&&typeof ref.url==="string"&&typeof ref.isInternal==="boolean"))return 0;
 return new Set(refs.filter(ref=>visibleUrls.has(ref.url)).map(ref=>ref.url)).size;
}
export function hasVisibleAttachmentProvenance(value:unknown,visibleUrls:ReadonlySet<string>):boolean{return visibleAttachmentProvenanceCount(value,visibleUrls)>0;}

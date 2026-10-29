import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: api }));
vi.mock("@/lib/attachments/prepare-image", () => ({ prepareImagesForUpload: async (files: File[]) => files }));
import { TaskFormAttachments, uploadTaskAttachments, attachmentUploadErrorMessage, isDefinitiveUploadRefusal } from "./TaskFormAttachments";
afterEach(() => { cleanup(); api.mockReset(); });

it.each([{disabled:true}, {busy:true}])("cancels locked drag/drop browser defaults and bubbling: %j", props => {
 const change=vi.fn(), parentDrop=vi.fn(), parentDrag=vi.fn();
 render(<div onDrop={parentDrop} onDragOver={parentDrag}><TaskFormAttachments id="files" files={[]} onChange={change} {...props}/></div>);
 const group=screen.getByRole("group");
 const drag=createEvent.dragOver(group,{cancelable:true}); fireEvent(group,drag);
 const drop=createEvent.drop(group,{cancelable:true,dataTransfer:{files:[new File(["pdf"],"file.pdf",{type:"application/pdf"})]}}); fireEvent(group,drop);
 expect(drag.defaultPrevented).toBe(true); expect(drop.defaultPrevented).toBe(true);
 expect(parentDrag).not.toHaveBeenCalled(); expect(parentDrop).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});

it("sets empty MIME from an allowed extension without changing uploaded bytes",async()=>{
 api.mockResolvedValue({uploaded:[{url:"/file",name:"scan.PDF",size:3,mime:"application/pdf"}],count:1});
 const original=new File(["pdf"],"scan.PDF",{lastModified:42});
 await uploadTaskAttachments("task",[original]);
 const body=api.mock.calls[0][1].body as FormData, sent=body.get("files") as File;
 expect(sent.type).toBe("application/pdf");expect(sent.name).toBe("scan.PDF");expect(sent.size).toBe(original.size);
 const read=(blob:Blob)=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsText(blob);});
 expect(await read(sent)).toBe(await read(original));
});

it.each([{}, {uploaded:[],count:0},{uploaded:[{url:"/file",name:"a.pdf",size:3}],count:1},{uploaded:[{url:"/file",name:"a.pdf",mime:"application/pdf",size:3}],count:2}])("treats malformed/partial successful responses as uncertain: %j",async result=>{
 api.mockResolvedValue(result);await expect(uploadTaskAttachments("task",[new File(["pdf"],"a.pdf",{type:"application/pdf"})])).rejects.toThrow("UPLOAD_UNCONFIRMED");
});

it("names a quota only for its exact error code, never an unrelated 409",()=>{
 const error=(code:string)=>Object.assign(new Error("SYNTHETIC_RAW_SECRET"),{status:409,payload:{error:{code}}});
 expect(attachmentUploadErrorMessage(error("ATTACHMENT_QUOTA_EXCEEDED"),"Файлы")).toContain("лимит вложений");
 const other=attachmentUploadErrorMessage(error("STALE_TASK_VERSION"),"Файлы");expect(other).not.toContain("лимит");expect(other).not.toContain("SYNTHETIC_RAW_SECRET");
 expect(isDefinitiveUploadRefusal(error("FORBIDDEN"))).toBe(true);
 expect(isDefinitiveUploadRefusal({status:408})).toBe(false);expect(isDefinitiveUploadRefusal({status:503})).toBe(false);
});

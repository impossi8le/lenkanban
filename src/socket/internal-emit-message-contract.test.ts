import { describe, expect, it } from 'vitest';
import { isInternalEmitPayload } from './internal-emit-contract';
const message = { id: 'm', taskId: 't', authorId: 'a', author: {id: 'a'}, contentText: 'Synthetic comment', attachments: [], visibility: 'PUBLIC', isInternal: false };
describe.each(['message:new', 'message:updated'])('HTTP %s bridge contract', event => {
  it.each(['PUBLIC','INTERNAL'])('accepts explicit %s visibility for recipient authorization', visibility => {
    expect(isInternalEmitPayload({event,roomId:'project:p',data:{...message,visibility,isInternal:visibility==='INTERNAL'}})).toBe(true);
  });
  it.each([{taskId:''},{authorId:'other'},{visibility:'UNKNOWN'},{isInternal:true},{attachments:null},{author:null}])('rejects inconsistent or malformed message %#', change => {
    expect(isInternalEmitPayload({event,roomId:'project:p',data:{...message,...change}})).toBe(false);
  });
  it('rejects wrong project binding and personal-room injection', () => {
    expect(isInternalEmitPayload({event,roomId:'project:p',data:{...message,projectId:'other'}})).toBe(false);
    expect(isInternalEmitPayload({event,roomId:'user:a',data:message})).toBe(false);
  });
});

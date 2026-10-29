import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admission: vi.fn(), contentEffect:vi.fn(), notifications:vi.fn() }));
vi.mock("@/features/kanban/server/task-lifecycle-service",()=>({commitBeznalContentEffect:mocks.contentEffect}));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications",()=>({persistTaskContentNotifications:mocks.notifications}));
vi.mock("./write-access", () => ({ prepareTaskAttachmentWrite: mocks.admission }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { appendTaskAttachments, MAX_TASK_ATTACHMENTS } from "./append";
const attachment = { url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "report.pdf", size: 20, mime: "application/pdf" };
beforeEach(() => { vi.resetAllMocks(); mocks.admission.mockResolvedValue({ marked: true, projectId: "project" });mocks.contentEffect.mockResolvedValue({claimed:false,phaseChanged:false});mocks.notifications.mockResolvedValue([]); });
function fixture() {
  let state = { attachments: [] as typeof attachment[], version: 7, activities: 0 };
  const tx = { user:{findUnique:vi.fn(async()=>({name:"Автор"}))}, task: {
    findUnique: vi.fn(async () => structuredClone(state)),
    updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { attachments: typeof attachment[] } }) => {
      if (where.version !== state.version) return { count: 0 };
      state.attachments = structuredClone(data.attachments); state.version++; return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: { attachments: typeof attachment[] } }) => { state.attachments = structuredClone(data.attachments); }),
  }, activity: { create: vi.fn(async () => { state.activities++; return {}; }) } };
  // Transaction model verifies rollback expectations; this is not PostgreSQL evidence.
  const append = async (files = [attachment],invoiceIntent=false,discussionDraft=false) => {
    const before = structuredClone(state);
    try { return await appendTaskAttachments(tx as unknown as Prisma.TransactionClient, { actorId: "actor", taskId: "task", expectedProjectId: "project", attachments: files,invoiceIntent,discussionDraft }); }
    catch (error) { state = before; throw error; }
  };
  return { tx, append, state: () => state };
}
it("increments only the marked task version once with the same atomic Activity", async () => {
  const f = fixture();
  await f.append();
  expect(f.tx.task.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: "task", projectId: "project", version: 7 }, data: { attachments: [attachment], version: { increment: 1 } } });
  expect(f.state()).toEqual({ attachments: [attachment], version: 8, activities: 1 });
  expect(f.tx.task.update).not.toHaveBeenCalled();
  expect((await f.append()).added).toEqual([]);
  expect(f.state().version).toBe(8); expect(f.tx.activity.create).toHaveBeenCalledOnce();
});
it("keeps legacy append version semantics unchanged", async () => {
  mocks.admission.mockResolvedValue({ marked: false, projectId: "project" });
  const f = fixture(); await f.append();
  expect(f.state().version).toBe(7); expect(f.tx.task.update).toHaveBeenCalledOnce(); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
});
it("refuses a zero-row CAS without creating Activity", async () => {
  const f = fixture(); f.tx.task.updateMany.mockResolvedValue({ count: 0 });
  await expect(f.append()).rejects.toMatchObject({ code: "STALE_TASK_VERSION" });
  expect(f.state()).toEqual({ attachments: [], version: 7, activities: 0 }); expect(f.tx.activity.create).not.toHaveBeenCalled();
});
it("rolls attachment metadata/version back with mandatory Activity failure", async () => {
  const f = fixture(); f.tx.activity.create.mockRejectedValue(Error("synthetic-private-activity"));
  await expect(f.append()).rejects.toThrow();
  expect(f.state()).toEqual({ attachments: [], version: 7, activities: 0 });
});
it("checks quota before CAS and creates no version or Activity for a refused batch", async () => {
  const f = fixture();
  const files = Array.from({ length: MAX_TASK_ATTACHMENTS + 1 }, (_, i) => ({ ...attachment, url: `object-${i}` }));
  await expect(f.append(files)).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
  expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
});

it("records exact attachment provenance atomically without names or contents",async()=>{
 const f=fixture();await f.append();
 expect(f.tx.activity.create).toHaveBeenCalledWith({data:{taskId:"task",userId:"actor",action:"attachment_added",oldValue:undefined,newValue:{count:1,files:[{url:attachment.url,isInternal:false}]}}});
 expect(JSON.stringify(f.tx.activity.create.mock.calls)).not.toContain(attachment.name);
});

it("runs invoice effect only after successful new public file persistence and skips replay",async()=>{
 mocks.admission.mockResolvedValue({marked:true,projectId:"project",beznal:true});const f=fixture();await f.append([attachment],true);
 expect(mocks.contentEffect).toHaveBeenCalledWith(expect.objectContaining({kind:"invoice",public:true,invoiceUrl:attachment.url,versionAlreadyIncremented:true}));
 expect(f.tx.task.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.contentEffect.mock.invocationCallOrder[0]);
 await f.append();expect(mocks.contentEffect).toHaveBeenCalledTimes(1);expect(mocks.notifications).toHaveBeenCalledTimes(1);
});
it("does not invoke invoice effect or notifications when attachment CAS fails",async()=>{
 mocks.admission.mockResolvedValue({marked:true,projectId:"project",beznal:true});const f=fixture();f.tx.task.updateMany.mockResolvedValue({count:0});await expect(f.append()).rejects.toThrow();expect(mocks.contentEffect).not.toHaveBeenCalled();expect(mocks.notifications).not.toHaveBeenCalled();
});

it("chat-staged public file does not claim or mark invoice before public message commit",async()=>{
 mocks.admission.mockResolvedValue({marked:true,projectId:"project",beznal:true});const f=fixture();await f.append();expect(mocks.contentEffect).not.toHaveBeenCalled();expect(f.state().attachments).toHaveLength(1);
});

it("discussion staging creates only guarded provenance and no new feature notification or invoice effect",async()=>{
 mocks.admission.mockResolvedValue({marked:true,projectId:"project",beznal:true});const f=fixture();await f.append([attachment],false,true);
 expect(f.state().attachments).toEqual([{...attachment,pendingMessageAuthorId:"actor"}]);
 expect(f.tx.activity.create).toHaveBeenCalledWith({data:expect.objectContaining({newValue:expect.objectContaining({discussionDraft:true})})});expect(mocks.notifications).not.toHaveBeenCalled();expect(mocks.contentEffect).not.toHaveBeenCalled();
});

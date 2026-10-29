import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({read:vi.fn(),rows:vi.fn(),files:vi.fn()}));
vi.mock("@/lib/prisma",()=>({prisma:{activity:{findMany:mocks.rows}}}));
vi.mock("@/lib/task-related-access",()=>({findAvailableRelatedEndpoint:mocks.read}));
vi.mock("@/lib/require-api-user",()=>({requireApiUser:async()=>({id:"reader",globalRole:"USER"}),UnauthorizedError:class extends Error{}}));
vi.mock("@/lib/attachments/task-port",()=>({readTaskAttachmentAccess:mocks.files}));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access",()=>({canActorReadInternal:async()=>false,loadInternalMessageIds:async()=>new Set(),loadProjectDiscussionFacts:async()=>({})}));
import {GET} from "./route";
const history=(id:string,urls:string[])=>({id,taskId:"task",action:"attachment_added",oldValue:{files:[{url:"PRIVATE_OLD_URL"}]},newValue:{count:urls.length,files:urls.map(url=>({url,isInternal:url.includes("internal")}))}});
const get=async()=>(await (await GET(new Request("https://app.test/api/activities?taskId=task"))).json()).data;
beforeEach(()=>{vi.resetAllMocks();mocks.read.mockResolvedValue({id:"task",projectId:"project"});mocks.files.mockResolvedValue({status:"ok",attachments:[{url:"public-file"}]});mocks.rows.mockResolvedValue([history("public",["public-file"]),history("mixed",["public-file","internal-file"]),history("hidden",["internal-file"]),{id:"legacy",action:"attachment_added",newValue:{count:1}},{id:"other",action:"request_info_requested"}]);});
it("hides internal exact events and strips provenance for every emitted new file event",async()=>{
 const result=await get();expect(result.map((row:{id:string})=>row.id)).toEqual(["public","mixed","legacy","other"]);
 for(const row of result.slice(0,2)){expect(row.newValue).toEqual({count:1});expect(row.oldValue).toBeNull();}
 expect(JSON.stringify(result)).not.toContain("public-file");expect(JSON.stringify(result)).not.toContain("internal-file");expect(JSON.stringify(result)).not.toContain("PRIVATE_OLD_URL");
});
it("rechecks current file classification; removal/reclassification hides the whole event",async()=>{
 expect(await get()).toHaveLength(4);mocks.files.mockResolvedValue({status:"ok",attachments:[]});expect((await get()).map((row:{id:string})=>row.id)).toEqual(["legacy","other"]);
});
it("fails closed on malformed provenance or unavailable current file read",async()=>{
 mocks.rows.mockResolvedValue([{...history("malformed",["public-file"]),newValue:{files:[{url:"public-file"}]}}]);expect(await get()).toEqual([]);
 mocks.rows.mockResolvedValue([history("unknown",["public-file"])]);mocks.files.mockResolvedValue({status:"missing"});expect(await get()).toEqual([]);
});

import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({auth:vi.fn(),boards:vi.fn(),policy:vi.fn()}));
vi.mock("@/lib/prisma",()=>({prisma:{project:{findMany:mocks.boards}}}));
vi.mock("@/lib/require-api-user",()=>({requireApiUser:mocks.auth,UnauthorizedError:class extends Error{}}));
vi.mock("@/lib/project-creation-policy",()=>({getProjectCreationPolicy:mocks.policy}));
import {GET} from "./route";
import {projectReadPredicate} from "@/lib/access-policy";
const outsider={id:"outsider",globalRole:"USER" as const};
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue(outsider);mocks.boards.mockResolvedValue([{id:"bank-secret",name:"Безнал ОП"},{id:"bank-applicant",name:"Безнал ОП"}]);});
it("discovers submission-only bank direction using shared applicant permission without board membership",async()=>{
 mocks.policy.mockImplementation(async(_actor,id)=>({canCreate:id==='bank-applicant'}));
 const response=await GET(new Request('http://localhost/api/request-directions'));
 expect(response.status).toBe(200);
 expect(mocks.boards).toHaveBeenCalledWith({where:{OR:[projectReadPredicate(outsider),{name:{equals:'Безнал ОП',mode:'insensitive'}}]},select:{id:true,name:true},orderBy:{updatedAt:'desc'},take:40});
 expect(mocks.policy).toHaveBeenCalledWith(outsider,'bank-secret');expect(mocks.policy).toHaveBeenCalledWith(outsider,'bank-applicant');
 expect((await response.json()).data).toEqual({beznal:{projectId:'bank-applicant',projectName:'Безнал ОП'}});
});
it("returns no destination or hidden board ID when shared creation denies outsider",async()=>{
 mocks.policy.mockResolvedValue({canCreate:false});
 const body=await(await GET(new Request('http://localhost/api/request-directions'))).json();
 expect(body.data).toEqual({});expect(JSON.stringify(body)).not.toContain('bank-secret');expect(JSON.stringify(body)).not.toContain('bank-applicant');
});

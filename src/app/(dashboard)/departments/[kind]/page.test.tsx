import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), boards: vi.fn(), read: vi.fn(), create: vi.fn(), predicate: vi.fn(), access:vi.fn() }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: mocks.boards } } }));
vi.mock("@/lib/access-policy", () => ({ projectReadPredicate: mocks.predicate }));
vi.mock("@/lib/project-access", () => ({ requireProjectRead: mocks.read, getProjectReadWhere: mocks.predicate, getProjectAccess: mocks.access }));
vi.mock("@/lib/project-creation-policy", () => ({ getProjectCreationPolicy: mocks.create }));
vi.mock("@/components/dashboard/ApplicantDirection",()=>({ApplicantDirection:({projectName,initiallyOpen}:{projectName:string;initiallyOpen:boolean})=><div data-open={String(initiallyOpen)}>Создать: {projectName}</div>}));
vi.mock("@/components/dashboard/AuthorizedDepartmentRedirect",()=>({AuthorizedDepartmentRedirect:({href}:{href:string})=><a href={href}>Открыть доску</a>}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
import DepartmentPage from "./page";
const actor = { id: "applicant", globalRole: "USER" };
const props = (kind = "support", create?: string) => ({ params: Promise.resolve({ kind }), searchParams: Promise.resolve({ create }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue(actor);
  mocks.predicate.mockReturnValue({ members: { some: { userId: actor.id } } });
  mocks.boards.mockResolvedValue([{ id: "portable-qa-it", name: "Техподдержка и ИТ" }, { id: "portable-qa-claim", name: "Претензии клиентов" }]);
  mocks.read.mockResolvedValue({ canRead: true });
  mocks.create.mockResolvedValue({ canCreate: true });
});
describe("portable department aliases", () => {
  it("resolves local authorized IDs and preserves creation intent only after fresh policies", async () => {
    expect(renderToStaticMarkup(await DepartmentPage(props("claim", "task")))).toContain('href="/projects/portable-qa-claim/board?view=board&amp;create=task"');
    expect(mocks.boards).toHaveBeenCalledWith(expect.objectContaining({ where: { members: { some: { userId: actor.id } } } }));
    expect(mocks.read).toHaveBeenCalledWith(actor, "portable-qa-claim");
    expect(mocks.create).toHaveBeenCalledWith(actor, "portable-qa-claim");
  });
  it("allows read-only navigation but denies a create intent", async () => {
    mocks.create.mockResolvedValue({ canCreate: false });
    const denied = renderToStaticMarkup(await DepartmentPage(props("support", "task")));
    expect(denied).toContain("нет доступного направления");
    expect(denied).not.toContain("portable-qa-it");
    expect(renderToStaticMarkup(await DepartmentPage(props()))).toContain('href="/projects/portable-qa-it/board?view=board"');
  });
  it("fails closed on missing session or revoked read access", async () => {
    mocks.user.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    await expect(DepartmentPage(props())).rejects.toThrow("UNAUTHORIZED");
    expect(mocks.boards).not.toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(DepartmentPage(props("support", "task"))).rejects.toThrow("NOT_FOUND");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not resolve unknown public aliases and exposes no unavailable board IDs", async () => {
    await expect(DepartmentPage(props("other"))).rejects.toThrow("NOT_FOUND");
    expect(mocks.user).not.toHaveBeenCalled();
    mocks.boards.mockResolvedValue([]);
    const html = renderToStaticMarkup(await DepartmentPage(props()));
    expect(html).toContain("недоступен или ещё не настроен");
    expect(html).not.toContain("portable-qa");
  });
});

it("opens creation for a group-only applicant without granting board read",async()=>{
 mocks.boards.mockResolvedValue([{id:"bank",name:"Безнал ОП"}]);mocks.access.mockResolvedValue({canRead:false});mocks.create.mockResolvedValue({canCreate:true});
 const html=renderToStaticMarkup(await DepartmentPage(props("beznal","task")));
 expect(html).toContain("Создать: Безнал ОП");expect(html).toContain('data-open="true"');
 expect(mocks.read).not.toHaveBeenCalled();expect(mocks.create).toHaveBeenCalledWith(actor,"bank");
});
it("does not disclose an applicant direction when both read and creation are denied",async()=>{
 mocks.boards.mockResolvedValue([{id:"secret-bank",name:"Безнал ОП"}]);mocks.access.mockResolvedValue({canRead:false});mocks.create.mockResolvedValue({canCreate:false});
 const html=renderToStaticMarkup(await DepartmentPage(props("beznal","task")));
 expect(html).toContain("нет доступного направления");expect(html).not.toContain("secret-bank");expect(html).not.toContain("Создать:");
});

it.each([undefined,"task"])("preserves the exact authorized bank destination and create intent %s",async(create)=>{
 mocks.boards.mockResolvedValue([{id:"bank-authorized",name:"Безнал ОП"}]);mocks.access.mockResolvedValue({canRead:true});
 const html=renderToStaticMarkup(await DepartmentPage(props("beznal",create)));
 expect(html).toContain(`/projects/bank-authorized/board?view=board${create?"&amp;create=task":""}`);
 expect(mocks.access).toHaveBeenCalledWith(actor,"bank-authorized");expect(mocks.create).toHaveBeenCalledWith(actor,"bank-authorized");
});
it("does not navigate a readable bank board to creation when creation is denied",async()=>{
 mocks.boards.mockResolvedValue([{id:"bank-authorized",name:"Безнал ОП"}]);mocks.access.mockResolvedValue({canRead:true});mocks.create.mockResolvedValue({canCreate:false});
 const html=renderToStaticMarkup(await DepartmentPage(props("beznal","task")));
 expect(html).not.toContain("bank-authorized");expect(html).toContain("нет доступного направления");
});

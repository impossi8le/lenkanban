import { beforeEach, describe, expect, it, vi } from "vitest";
const policy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/project-creation-policy", () => ({ getProjectCreationPolicy: policy }));
import { resolveRequestDirections } from "./request-direction-options";
beforeEach(() => policy.mockReset());
describe("creation directions", () => {
  it("offers only real boards allowed by shared creation policy", async () => {
    policy.mockImplementation(async (_user, id) => ({ canCreate: id !== "denied" }));
    const actor = { id: "user", globalRole: "USER" as const };
    const result = await resolveRequestDirections(actor, [{ id: "denied", name: "Техподдержка" }, { id: "allowed", name: "ИТ" }, { id: "claims", name: "Претензии клиентов" }, { id: "other", name: "Бухгалтерия" }]);
    expect(result).toEqual({ support: { projectId: "allowed", projectName: "ИТ" }, claim: { projectId: "claims", projectName: "Претензии клиентов" } });
    expect(policy).not.toHaveBeenCalledWith(actor, "other");
  });
  it("bounds checks and never invents unavailable destinations", async () => {
    policy.mockResolvedValue({ canCreate: false });
    expect(await resolveRequestDirections({ id: "user", globalRole: "USER" }, Array.from({ length: 20 }, (_, i) => ({ id: `it-${i}`, name: "Техподдержка" })))).toEqual({ support: undefined, claim: undefined });
    expect(policy).toHaveBeenCalledTimes(3);
  });
});

it("discovers Безнал ОП only through shared creation policy",async()=>{
 policy.mockImplementation(async(_actor,id)=>({canCreate:id==='bank-allowed'}));
 const actor={id:'actor',globalRole:'USER' as const};
 const result=await resolveRequestDirections(actor,[{id:'bank-denied',name:'Безнал ОП'},{id:'bank-allowed',name:'Безнал ОП'},{id:'unrelated',name:'Бухгалтерия'}]);
 expect(result.beznal).toEqual({projectId:'bank-allowed',projectName:'Безнал ОП'});
 expect(policy).toHaveBeenCalledWith(actor,'bank-denied');expect(policy).not.toHaveBeenCalledWith(actor,'unrelated');
});

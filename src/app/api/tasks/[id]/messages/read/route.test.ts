import { expect, it } from "vitest";
import { fixture, marker, boundary } from "./route-test-support";
import { POST } from "./route";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";
it("permits a valid CLOSED common reader without invoking a lifecycle writer", async()=>{
 const f=fixture();f.options.marker=marker("CLOSED");expect((await POST(f.request(),f.context)).status).toBe(200);
 expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
 expect(f.tx.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({AND:expect.arrayContaining([{id:"task-1",projectId:"project-1"}])})}));
});
it("intersects explicit IDs with ordinary visibility and preserves atomic first timestamp",async()=>{
 const f=fixture();expect(await(await POST(f.request({messageIds:["shown","hidden-internal"]}),f.context)).json()).toEqual({ok:true,markedRead:1});const statement=f.statement();
 expect(statement.sql).toContain('AND "isInternal" = false');expect(statement.sql).toContain('WHERE "taskId" = ?');expect(statement.sql).toContain('AND "id" IN (?,?)');
 expect(statement.sql).toContain('|| jsonb_build_object(?::text, ?::text)');
 expect(statement.sql).toContain('AND NOT (COALESCE(NULLIF("readBy", \'null\'::jsonb), \'{}\'::jsonb) ? ?::text)');
 expect(statement.values).toEqual(["viewer",expect.any(String),"task-1","shown","hidden-internal","viewer"]);
 expect(boundary.internal).toHaveBeenCalledWith(f.tx,expect.objectContaining({id:"viewer",globalRole:"USER"}),expect.anything());
});
it("uses the existing internal reader policy",async()=>{const f=fixture();boundary.internal.mockResolvedValue(true);expect((await POST(f.request(),f.context)).status).toBe(200);expect(f.statement().sql).not.toContain('"isInternal" = false');});
it("supports legacy {} without marking invisible internal messages",async()=>{const f=fixture();expect((await POST(f.request({}),f.context)).status).toBe(200);expect(f.statement().sql).not.toContain('"id" IN');expect(f.statement().sql).toContain('AND "isInternal" = false');});
it("rejects anonymous identity before any task lookup",async()=>{const f=fixture();boundary.auth.mockRejectedValue(new UnauthorizedError());expect((await POST(f.request(),f.context)).status).toBe(401);expect(f.database.task.findFirst).not.toHaveBeenCalled();expect(f.database.$transaction).not.toHaveBeenCalled();});
it("preserves forbidden authentication response without entering a transaction",async()=>{const f=fixture();boundary.auth.mockRejectedValue(new ForbiddenError());expect((await POST(f.request(),f.context)).status).toBe(403);expect(f.database.$transaction).not.toHaveBeenCalled();});
it("returns404 before writes for initially invisible task",async()=>{const f=fixture();f.options.outerReadable=false;expect((await POST(f.request(),f.context)).status).toBe(404);expect(f.database.$transaction).not.toHaveBeenCalled();});
it.each([null,{messageIds:"shown"},{messageIds:[1]},{messageIds:[""]},{messageIds:Array(1001).fill("shown")}])("rejects invalid batches %#",async body=>{const f=fixture();expect((await POST(f.request(body),f.context)).status).toBe(400);expect(f.database.$transaction).not.toHaveBeenCalled();});
it("parameterizes SQL-looking explicit IDs",async()=>{const f=fixture(),id="message') OR true --";expect((await POST(f.request({messageIds:[id]}),f.context)).status).toBe(200);expect(f.statement().values).toContain(id);expect(f.statement().sql).not.toContain(id);});

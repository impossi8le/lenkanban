import { describe, expect, it } from "vitest";
import { parseProjectContext, parseProjectView, projectCreateTaskHref, projectViewHref } from "./project-navigation";

describe("canonical project navigation", () => {
  it.each(["board", "table", "calendar"] as const)("accepts %s", (view) => {
    expect(parseProjectView(view)).toBe(view);
    expect(projectViewHref("p1", view)).toBe(`/projects/p1/board?view=${view}`);
  });
  it.each([null, "", "TABLE", "constructor", "unknown"])("rejects invalid view %s", (view) => {
    expect(parseProjectView(view)).toBeNull();
  });
  it.each(["/projects/p1/board", "/projects/p1/board/", "/projects/p1/tasks/t1"])("recognizes %s", (path) => {
    expect(parseProjectContext(path)).toEqual({ projectId: "p1" });
  });
  it.each([null, "/projects", "/settings", "/projects/p1/table", "/projects/p1/board/nested", "/projects/p1/tasks", "/projects/%2f/board", "/projects/%5c/board", "/projects/%00/board", "/projects/%/board"])("rejects non-context %s", (path) => {
    expect(parseProjectContext(path)).toBeNull();
  });
  it("encodes project IDs and preserves unrelated repeated parameters", () => {
    expect(projectViewHref("проект ?", "calendar", new URLSearchParams("filter=a&filter=b&task=t1&create=task&view=table")))
      .toBe("/projects/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%3F/board?filter=a&filter=b&view=calendar");
    expect(parseProjectContext("/projects/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%3F/board"))
      .toEqual({ projectId: "проект ?" });
  });
  it("opens creation on the chosen view without an old task intent", () => {
    expect(projectCreateTaskHref("p1", new URLSearchParams("view=table&task=t1&filter=x")))
      .toBe("/projects/p1/board?view=table&filter=x&create=task");
    expect(projectCreateTaskHref("p1", new URLSearchParams("view=invalid")))
      .toBe("/projects/p1/board?view=board&create=task");
  });
});

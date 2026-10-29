import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { API_ROUTE_TEMPLATES, apiRouteTemplate } from "./api-observation-routes";

it("has exactly the closed root API route manifest, including future route drift", () => {
  const root = path.resolve("src/app/api");
  const templates: string[] = [];
  function visit(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) visit(path.join(dir, item.name));
      else if (item.name === "route.ts") templates.push("/api" + path.relative(root, dir).split(path.sep).filter(Boolean).map(part => "/" + (part.startsWith("[") ? ":" + part.replace(/[\[\]]/g, "") : part)).join(""));
    }
  }
  visit(root);
  expect([...API_ROUTE_TEMPLATES].sort()).toEqual(templates.sort());
});
it("selects static labels without retaining values, queries or unmatched paths", () => {
  expect(apiRouteTemplate("/api/tasks/private-task/checklist/private-item?password=PRIVATE")).toBe("/api/tasks/:id/checklist/:itemId");
  expect(apiRouteTemplate("/api/tasks/bulk-update")).toBe("/api/tasks/bulk-update");
  expect(apiRouteTemplate("/api/my-day?date=PRIVATE_DIARY_DATE")).toBe("/api/my-day");
  expect(apiRouteTemplate("/api/tasks/changes?taskId=PRIVATE_TASK")).toBe("/api/tasks/changes");
  expect(apiRouteTemplate("/api/tasks/PRIVATE_TASK/viewed")).toBe("/api/tasks/:id/viewed");
  expect(apiRouteTemplate("/api/problem-reports/PRIVATE_REPORT/comment")).toBe("/api/problem-reports/:reportId/comment");
  expect(apiRouteTemplate("/api/tasks/private-task/messages/mention-candidates?search=PRIVATE_PERSON")).toBe("/api/tasks/:id/messages/mention-candidates");
  expect(apiRouteTemplate("/api/tasks/private-task/related?search=PRIVATE_PERSON")).toBe("/api/tasks/:id/related");
  expect(apiRouteTemplate("/api/tasks/private-task/queue-seen?actorId=PRIVATE_ACTOR&epoch=PRIVATE_EPOCH")).toBe("/api/tasks/:id/queue-seen");
  expect(apiRouteTemplate("/api/tasks/queue-unseen?projectId=PRIVATE_BOARD#PRIVATE_FRAGMENT")).toBe("/api/tasks/queue-unseen");
  expect(apiRouteTemplate("/api/auth/callback/credentials")).toBe("/api/auth/:...nextauth");
  expect(apiRouteTemplate("/api/PRIVATE/value")).toBe("/api/:unmatched");
  expect(apiRouteTemplate("/api/tasks/a/missing")).toBe("/api/:unmatched");
  expect(apiRouteTemplate("/not-api/private")).toBeUndefined();
  expect(apiRouteTemplate(new Proxy({}, { get() { throw Error("PRIVATE"); } }))).toBeUndefined();
});

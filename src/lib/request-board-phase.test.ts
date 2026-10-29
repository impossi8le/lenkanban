import { expect, it } from "vitest";
import { getRequestBoardPhase } from "./request-board-phase";
it("uses the same invoice phase for a free or assigned request", () => {
  expect(getRequestBoardPhase({ request: { state: "IN_PROGRESS" }, attachments: [] }, true)).toEqual({ code: "WAITING", label: "Ждут обработки" });
  expect(getRequestBoardPhase({ request: { state: "IN_PROGRESS" }, attachments: [{}] }, true)).toEqual({ code: "INVOICED", label: "Со счётом" });
});
it.each(["COMPLETED", "CLOSED", "CANCELLED"])("keeps %s in the archive even with an invoice", state => {
  expect(getRequestBoardPhase({ request: { state }, attachments: [{}] }, true)).toEqual({ code: "CLOSED", label: "Закрыто" });
});
it("preserves other departments' own stages", () => {
  expect(getRequestBoardPhase({ request: { state: "NEEDS_INFO" } })).toEqual({ code: "NEEDS_INFO", label: "Ждём сотрудника" });
  expect(getRequestBoardPhase({ request: { state: "NEEDS_INFO" } }, false, true)).toEqual({ code: "IN_PROGRESS", label: "В работе" });
});
it("keeps a returned request waiting while preserving old invoice files", () => {
  expect(getRequestBoardPhase({ request: { state: "IN_PROGRESS", beznalPhase: "WAITING" }, attachments: [{}] }, true)).toEqual({ code: "WAITING", label: "Ждут обработки" });
  expect(getRequestBoardPhase({ request: { state: "IN_PROGRESS", beznalPhase: "INVOICED" }, attachments: [] }, true)).toEqual({ code: "INVOICED", label: "Со счётом" });
});

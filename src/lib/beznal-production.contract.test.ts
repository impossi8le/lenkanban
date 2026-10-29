import { describe, expect, it } from "vitest";
import { decodeRequestDescription, encodeRequestDescription, isBeznalProject, requestDetailsSchema } from "./request-presentation";
import { createTaskSchema } from "./validators";
import { classifyDirectionName } from "./request-directions";

const minimal = { kind: "beznal" as const, category: "Безнал ОП" };

describe("Безнал ОП independent production contract", () => {
  it("accepts creation with every bank field omitted and the existing common fields", () => {
    const parsed = createTaskSchema.safeParse({ projectId: "qa_board", title: "Определить платёж", description: "", priority: "LOW", audience: { mode: "DEPARTMENT", userIds: [] }, requestDetails: minimal });
    expect(parsed.success).toBe(true);
    expect(requestDetailsSchema.safeParse({ ...minimal, bankKind: "", company: "", amount: "", paymentDate: "", invoiceNumber: "", orderNumber: "", paymentPurpose: "" }).success).toBe(true);
    expect(createTaskSchema.safeParse({ projectId: "qa_board", title: " ", audience: { mode: "DEPARTMENT", userIds: [] }, requestDetails: minimal }).success).toBe(false);
  });

  it.each(["invoice", "payment", "other"] as const)("roundtrips %s and literal multiline payment purpose through two description edits", bankKind => {
    const details = { ...minimal, bankKind, company: "ООО «Синтетика»", amount: "125 000,50", paymentDate: "2028-02-29", invoiceNumber: "СЧ-184/26", orderNumber: "Заказ-572", paymentPurpose: "Оплата по договору №17\nКонец сведений\n\nКатегория: другая\nНазначение платежа: \\\"тест\\\"" };
    const body = "Обычное описание\n\nСведения об обращении (v1)\nНаправление: it";
    let decoded = decodeRequestDescription(encodeRequestDescription(body, details));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(decoded.details).toMatchObject(details);
      const nextBody = `${body}\nПравка ${attempt}`;
      decoded = decodeRequestDescription(encodeRequestDescription(nextBody, decoded.details!));
      expect(decoded.body).toBe(nextBody);
    }
    expect(decoded.details).toMatchObject(details);
  });

  it("preserves optional blank values and keeps ordinary legacy descriptions unchanged", () => {
    const details = { ...minimal, bankKind: "" as const, company: "", amount: "", paymentDate: "", invoiceNumber: "", orderNumber: "", paymentPurpose: "" };
    expect(decodeRequestDescription(encodeRequestDescription(null, details))).toMatchObject({ details, body: "" });
    for (const body of ["Описание без реквизитов", "<p>Ранее созданная заявка</p>"]) expect(decodeRequestDescription(body)).toEqual({ details: null, body });
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "28.10.2026", "0000-01-01"])("rejects invalid date %s", paymentDate => {
    expect(requestDetailsSchema.safeParse({ ...minimal, paymentDate }).success).toBe(false);
  });

  it("rejects unbounded or forged metadata while retaining optional-field validation", () => {
    for (const field of ["company", "amount", "invoiceNumber", "orderNumber"] as const) {
      expect(requestDetailsSchema.safeParse({ ...minimal, [field]: "test\nНаправление: claim" }).success).toBe(false);
    }
    for (const [field, value] of [["company", "x".repeat(201)], ["amount", "x".repeat(41)], ["paymentPurpose", "x".repeat(1001)], ["bankKind", "admin"], ["executorId", "forged"]]) {
      expect(requestDetailsSchema.safeParse({ ...minimal, [field]: value }).success).toBe(false);
    }
    expect(requestDetailsSchema.safeParse({ kind: "claim", category: "Цена" }).success).toBe(false);
  });

  it("classifies only the agreed board name and keeps existing directions", () => {
    for (const name of ["Безнал ОП", " БЕЗНАЛ  ОП "]) {
      expect(isBeznalProject(name)).toBe(true);
      expect(classifyDirectionName(name)).toBe("beznal");
    }
    for (const name of ["Безнал", "Безнал ОП архив", "QA Безнал ОП", "Безнал ОП-2"]) expect(isBeznalProject(name)).toBe(false);
    expect(classifyDirectionName("Техподдержка и ИТ")).toBe("support");
    expect(classifyDirectionName("Претензии клиентов")).toBe("claim");
  });
});

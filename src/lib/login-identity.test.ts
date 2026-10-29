import { describe, expect, it } from "vitest";
import { displayLogin, normalizeLogin } from "./login-identity";

describe("login identity", () => {
  it.each(["байковпавел", " БАЙКОВПАВЕЛ ", "байковпавел@taskboard.lenremontn8n.ru"])("accepts Russian local login %s", input => {
    expect(normalizeLogin(input)).toBe("байковпавел@taskboard.lenremontn8n.ru");
  });
  it("preserves ё and accepts digits in Russian local aliases", () => {
    expect(normalizeLogin("СЕМЁНОВ1")).toBe("семёнов1@taskboard.lenremontn8n.ru");
    expect(displayLogin(normalizeLogin("СЕМЁНОВ1"))).toBe("семёнов1");
  });
  it.each(["байков павел", "байков.павел", "байков_павел", "байков-павел", "байков@other.invalid", "байков@@taskboard.lenremontn8n.ru", "я".repeat(255)])("rejects malformed Russian login %s", input => {
    expect(normalizeLogin(input)).toBe("");
  });
  it.each(["barhat", " BARHAT ", "barhat@taskboard.lenremontn8n.ru", " BARHAT@TASKBOARD.LENREMONTN8N.RU "])("resolves %s to the existing local account", (input) => {
    expect(normalizeLogin(input)).toBe("barhat@taskboard.lenremontn8n.ru");
  });
  it("preserves external email authentication", () => {
    expect(normalizeLogin(" Employee@Example.Invalid ")).toBe("employee@example.invalid");
  });
  it.each([undefined, null, 42, "", "   ", "has spaces", "a@@b.ru", "@taskboard.lenremontn8n.ru", "a@", ".bad", "a..b", "a".repeat(255)])("rejects malformed login %s", (input) => {
    expect(normalizeLogin(input)).toBe("");
  });
  it("removes only the exact synthetic domain from display", () => {
    expect(displayLogin("barhat@taskboard.lenremontn8n.ru")).toBe("barhat");
    expect(displayLogin("BARHAT@TASKBOARD.LENREMONTN8N.RU")).toBe("BARHAT");
    expect(displayLogin("barhat@other.invalid")).toBe("barhat@other.invalid");
    expect(displayLogin("barhat@sub.taskboard.lenremontn8n.ru")).toBe("barhat@sub.taskboard.lenremontn8n.ru");
    expect(displayLogin("barhat@taskboard.lenremontn8n.ru.evil.invalid")).toBe("barhat@taskboard.lenremontn8n.ru.evil.invalid");
    expect(displayLogin(null)).toBe("");
  });
});

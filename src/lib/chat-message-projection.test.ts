import { expect, it } from "vitest";
import { projectChatMessage, canChangeOwnMessage } from "./chat-message-projection";
it("suppresses every live content field in a tombstone and never broadcasts actor capabilities", () => {
 const result = projectChatMessage({ contentText: "private-before", attachments: [{ url: "private-ref" }], mentions: ["person"], reactions: { x: ["person"] }, readBy: { person: true }, deletedAt: "2026-10-27T00:00:00Z", canEdit: true, canDelete: true });
 expect(result).toEqual({ contentText: "", attachments: [], mentions: [], reactions: {}, readBy: {}, deletedAt: "2026-10-27T00:00:00Z" });
});
it("allows own current readable content states but never deleted/foreign/cancelled or missing-version controls", () => {
 const own = { authorId: "actor", version: 0 }; const request = { contractVersion: 1, authorId: "actor", state: "CLOSED", deletedAt: null };
 expect(canChangeOwnMessage(own, "actor", request)).toBe(true); expect(canChangeOwnMessage(own, "actor", null)).toBe(false); expect(canChangeOwnMessage(own, "actor", null, true)).toBe(true);
 for (const state of ["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "DRAFT"]) expect(canChangeOwnMessage(own,"actor",{ ...request,state })).toBe(true);
 expect(canChangeOwnMessage(own,"actor",{ ...request,state:"CANCELLED" })).toBe(false); expect(canChangeOwnMessage({ ...own,deletedAt:"date" },"actor",null)).toBe(false);
 expect(canChangeOwnMessage(own,"other",null)).toBe(false); expect(canChangeOwnMessage({authorId:"actor"},"actor",null)).toBe(false);
});

import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MY_DAY_ACTOR_HEADER, MY_DAY_SESSION_CHANGED, type MyDayEntry } from "@/lib/my-day-contract";

const runtime = vi.hoisted(() => ({ api: vi.fn(), update: vi.fn(), replace: vi.fn(), actor: "alice" }));
vi.mock("@/lib/api", () => ({ apiFetch: runtime.api }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/my-day", useSearchParams: () => new URLSearchParams("date=2026-10-29"),
  useRouter: () => ({ replace: runtime.replace }),
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: runtime.actor } }, update: runtime.update }) }));
import MyDayPage from "@/app/(dashboard)/my-day/page";
import { getMyDayDraftKey, reconcileMyDaySessionDrafts } from "./my-day-draft";

const day = "2026-10-29";
const privateA = "SYNTHETIC_PRIVATE_ALICE_DIARY";
const privateB = "SYNTHETIC_PRIVATE_BOB_DIARY";
const entry = (text = ""): MyDayEntry => ({ date: day, today: day, text, version: text ? 1 : 0, updatedAt: null });
function sessionChanged() {
  return Object.assign(new Error("Учётная запись изменилась."), { status: 403, payload: { success: false, error: { code: MY_DAY_SESSION_CHANGED, message: "Учётная запись изменилась." } } });
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
async function mount() { const view=render(<MyDayPage />); await act(async () => {}); return view; }
async function elapsed(ms = 1000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  vi.clearAllMocks(); sessionStorage.clear(); reconcileMyDaySessionDrafts(null,"unauthenticated");
  runtime.actor="alice"; runtime.update.mockResolvedValue(null);
});
afterEach(() => { cleanup(); reconcileMyDaySessionDrafts(null,"unauthenticated"); vi.clearAllTimers(); vi.useRealTimers(); });

describe("diary requests remain bound to the UI actor while auth cookies change", () => {
  it("binds both GET and PUT to the actor captured by the workspace", async () => {
    runtime.api.mockImplementation(async (_path: string, options?: RequestInit) => options?.method === "PUT" ? entry(privateA) : entry());
    await mount();
    expect(new Headers(runtime.api.mock.calls[0][1]?.headers).get(MY_DAY_ACTOR_HEADER)).toBe("alice");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: privateA } }); await elapsed();
    expect(new Headers(runtime.api.mock.calls[1][1]?.headers).get(MY_DAY_ACTOR_HEADER)).toBe("alice");
  });

  it("hides old text, clears drafts, stops queued saves and refreshes the provider before showing actor B", async () => {
    const put=deferred<MyDayEntry>();
    runtime.api.mockImplementation(async (_path: string, options?: RequestInit) => options?.method === "PUT" ? put.promise : entry(runtime.actor === "bob" ? privateB : ""));
    const view=await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: privateA } }); await elapsed();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: privateA+"_QUEUED" } }); await elapsed();
    expect(sessionStorage.getItem(getMyDayDraftKey("alice",day))).not.toBeNull();
    await act(async () => { put.reject(sessionChanged()); });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(privateA+"_QUEUED")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(getMyDayDraftKey("alice",day))).toBeNull();
    expect(runtime.update).toHaveBeenCalledExactlyOnceWith();
    await elapsed(5000);
    expect(runtime.api.mock.calls.filter(([,options]) => options?.method === "PUT")).toHaveLength(1);

    runtime.actor="bob"; view.rerender(<MyDayPage />); await act(async () => {});
    expect(screen.getByRole("textbox")).toHaveValue(privateB);
    const newGet=runtime.api.mock.calls.filter(([,options]) => options?.method !== "PUT").at(-1)!;
    expect(new Headers(newGet[1]?.headers).get(MY_DAY_ACTOR_HEADER)).toBe("bob");
    await elapsed(5000);
    expect(runtime.api.mock.calls.filter(([,options]) => options?.method === "PUT")).toHaveLength(1);
  });

  it("treats GET actor mismatch as terminal even while useSession still reports actor A", async () => {
    sessionStorage.setItem(getMyDayDraftKey("alice",day),JSON.stringify({actorId:"alice",date:day,text:privateA,baseVersion:0}));
    runtime.api.mockRejectedValue(sessionChanged());
    await mount();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(getMyDayDraftKey("alice",day))).toBeNull();
    expect(runtime.update).toHaveBeenCalledExactlyOnceWith();
    await elapsed(5000); expect(runtime.api).toHaveBeenCalledTimes(1);
  });
});

import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TaskType } from "@/components/kanban/Card";
const transport = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/task-scalar-transport", async original => ({ ...await original<typeof import("@/lib/task-scalar-transport")>(), readTaskDetails: transport.read, patchScalarCommand: transport.patch }));
import { useTaskScalarCommand } from "./useTaskScalarCommand";
const initial: TaskType = { id: "task", projectId: "project", title: "Initial", description: "Original", priority: "HIGH", columnId: "column", position: 1024, version: 7 };
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
function mount() { return renderHook(() => useTaskScalarCommand(initial, "project", "task"), { wrapper }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); transport.read.mockResolvedValue({ ...initial, version: 8, title: "Remote" }); transport.patch.mockResolvedValue({ taskId: "task", projectId: "project", version: 8 }); });
afterEach(() => { cleanup(); client.clear(); });
it("automatically applies clean assignment changes without locking or remounting the card", async () => {
  const view = mount(); act(() => view.result.current.reportLocalEdits(false));
  const assigned = { ...initial, version: 8, request: { state: "IN_PROGRESS", executorId: "executor" }, assignees: [{ id: "assignment", user: { id: "executor", name: "Специалист", email: "synthetic@example.invalid" } }] };
  transport.read.mockResolvedValueOnce(assigned);
  await act(() => view.result.current.readInBackground());
  expect(view.result.current.task).toEqual(assigned); expect(view.result.current.phase).toBe("idle"); expect(view.result.current.blocked).toBe(false); expect(view.result.current.generation).toBe(0);
  transport.patch.mockResolvedValueOnce({ taskId: "task", projectId: "project", version: 9 });
  transport.read.mockResolvedValueOnce({ ...assigned, version: 9, title: "Next edit" });
  await act(() => view.result.current.save("task", { title: "Next edit" }));
  expect(transport.patch.mock.calls[0][0].body.expectedVersion).toBe(8);
});
it("never adopts a newer version when typing starts during a clean background read", async () => {
  const view = mount(); act(() => view.result.current.reportLocalEdits(false));
  const response = deferred<TaskType>(); transport.read.mockReturnValueOnce(response.promise); let reading!: Promise<void>;
  act(() => { reading = view.result.current.readInBackground(); });
  act(() => view.result.current.reportLocalEdits(true, true));
  await act(async () => { response.resolve({ ...initial, version: 8 }); await reading; });
  expect(view.result.current.phase).toBe("conflict"); expect(view.result.current.task.version).toBe(7);
});
it("protects an edit undone during a pending read by its input revision", async () => {
  const view = mount(); act(() => view.result.current.reportLocalEdits(false));
  const response = deferred<TaskType>(); transport.read.mockReturnValueOnce(response.promise); let reading!: Promise<void>;
  act(() => { reading = view.result.current.readInBackground(); });
  act(() => { view.result.current.reportLocalEdits(true, true); view.result.current.reportLocalEdits(true, true); view.result.current.reportLocalEdits(false); });
  await act(async () => { response.resolve({ ...initial, version: 8 }); await reading; });
  expect(view.result.current.phase).toBe("conflict"); expect(view.result.current.task.version).toBe(7);
});
it("keeps the original baseline and blocks draft autosave until explicit conflict recovery", async () => {
  const view = mount(); await act(() => view.result.current.readInBackground());
  expect(view.result.current.phase).toBe("conflict"); expect(view.result.current.task).toEqual(initial); expect(view.result.current.generation).toBe(0);
  act(() => view.result.current.save("task", { title: "Local draft" })); expect(transport.patch).not.toHaveBeenCalled();
  await act(() => view.result.current.refresh()); expect(view.result.current.phase).toBe("idle"); expect(view.result.current.task.version).toBe(8); expect(view.result.current.generation).toBe(1); expect(transport.patch).not.toHaveBeenCalled();
});
it("preserves an unknown frozen command and callbacks until its exact explicit retry reconciles", async () => {
  transport.patch.mockRejectedValueOnce(new Error("lost-response")); const done = vi.fn(); const view = mount();
  await act(() => view.result.current.save("task", { title: "Draft" }, { onSuccess: done, onError: vi.fn() }));
  expect(view.result.current.phase).toBe("unknown"); const first = structuredClone(transport.patch.mock.calls[0][0]);
  await act(() => view.result.current.readInBackground()); expect(view.result.current.phase).toBe("unknown"); expect(view.result.current.task.version).toBe(7); expect(done).not.toHaveBeenCalled();
  await act(() => view.result.current.retry()); expect(transport.patch.mock.calls[1][0]).toEqual(first); expect(done).toHaveBeenCalledOnce(); expect(view.result.current.phase).toBe("idle"); expect(view.result.current.generation).toBe(0);
});
it("never treats a clean report as permission to unlock an unknown write", async () => {
  const view = mount(); act(() => view.result.current.reportLocalEdits(false));
  transport.patch.mockRejectedValueOnce(new Error("lost response"));
  await act(() => view.result.current.save("task", { title: "Sent title" }));
  const frozen = structuredClone(transport.patch.mock.calls[0][0]);
  act(() => view.result.current.reportLocalEdits(false));
  await act(() => view.result.current.readInBackground());
  expect(view.result.current.phase).toBe("unknown"); expect(view.result.current.task.version).toBe(7);
  await act(() => view.result.current.retry()); expect(transport.patch.mock.calls[1][0]).toEqual(frozen);
});
it("cannot clear a saving command or invoke its callback from a background success", async () => {
  const write = deferred<{ taskId: string; projectId: string; version: number }>(); transport.patch.mockReturnValueOnce(write.promise);
  const done = vi.fn(); const view = mount(); act(() => view.result.current.save("task", { title: "Draft" }, { onSuccess: done, onError: vi.fn() }));
  await act(() => view.result.current.readInBackground()); expect(view.result.current.phase).toBe("saving"); expect(done).not.toHaveBeenCalled(); expect(view.result.current.task.version).toBe(7);
  await act(() => write.resolve({ taskId: "task", projectId: "project", version: 8 })); expect(done).toHaveBeenCalledOnce(); expect(view.result.current.phase).toBe("idle"); expect(transport.patch).toHaveBeenCalledOnce();
});
it("does not remount or clear an existing conflict on automatic reread", async () => {
  transport.patch.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 })); const view = mount();
  await act(() => view.result.current.save("task", { title: "Draft" })); await act(() => view.result.current.readInBackground());
  expect(view.result.current.phase).toBe("conflict"); expect(view.result.current.generation).toBe(0); expect(view.result.current.task).toEqual(initial);
});
it("distinguishes unsupported marked scalar fields from a stale version and never retries the old intent", async () => {
  transport.patch.mockRejectedValueOnce(Object.assign(new Error("rejected"), { status: 409, payload: { error: { code: "REQUEST_LIFECYCLE_NOT_ENABLED" } } }));
  const failed = vi.fn(); const view = mount();
  await act(() => view.result.current.save("task", { title: initial.title, priority: "URGENT" }, { onSuccess: vi.fn(), onError: failed }));
  expect(view.result.current.phase).toBe("unsupported"); expect(failed).toHaveBeenCalledOnce();
  act(() => { view.result.current.retry(); view.result.current.save("task", { title: initial.title, priority: "URGENT" }); });
  expect(transport.patch).toHaveBeenCalledOnce();
  await act(() => view.result.current.refresh());
  expect(view.result.current.phase).toBe("idle"); expect(view.result.current.generation).toBe(1);
  expect(transport.patch).toHaveBeenCalledOnce(); expect(view.result.current.task.priority).toBe(initial.priority);
});
it.each([401, 403, 404])("hides a saving task on background %s and ignores its late successful write", async code => {
  const write = deferred<{ taskId: string; projectId: string; version: number }>(); transport.patch.mockReturnValueOnce(write.promise); const done = vi.fn(); const view = mount();
  act(() => view.result.current.save("task", { title: "Draft" }, { onSuccess: done, onError: vi.fn() })); transport.read.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: code }));
  await act(() => view.result.current.readInBackground()); expect(view.result.current.phase).toBe("denied");
  await act(() => write.resolve({ taskId: "task", projectId: "project", version: 8 })); expect(view.result.current.phase).toBe("denied"); expect(done).not.toHaveBeenCalled(); expect(transport.read).toHaveBeenCalledOnce();
  act(() => { view.result.current.retry(); view.result.current.refresh(); view.result.current.save("task", { title: "Another" }); }); expect(transport.patch).toHaveBeenCalledOnce();
});
it("keeps unknown denial latched when an earlier background read later succeeds", async () => {
  transport.patch.mockRejectedValueOnce(new Error("lost-response")); const view = mount(); await act(() => view.result.current.save("task", { title: "Draft" }));
  const earlier = deferred<TaskType>(); transport.read.mockReturnValueOnce(earlier.promise); let pending!: Promise<void>;
  act(() => { pending = view.result.current.readInBackground(); }); transport.read.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 403 }));
  await act(() => view.result.current.readInBackground()); await act(async () => { earlier.resolve({ ...initial, version: 9 }); await pending; });
  expect(view.result.current.phase).toBe("denied"); expect(view.result.current.task.version).toBe(7); act(() => view.result.current.retry()); expect(transport.patch).toHaveBeenCalledOnce();
});
it("cannot be unlocked by an earlier authoritative post-write read after background denial", async () => {
  const earlier = deferred<TaskType>(); transport.read.mockReturnValueOnce(earlier.promise); const done = vi.fn(); const view = mount();
  await act(() => view.result.current.save("task", { title: "Draft" }, { onSuccess: done, onError: vi.fn() })); expect(view.result.current.phase).toBe("reading");
  transport.read.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 404 })); await act(() => view.result.current.readInBackground());
  await act(() => earlier.resolve({ ...initial, version: 8 })); expect(view.result.current.phase).toBe("denied"); expect(done).not.toHaveBeenCalled();
});
it.each(["storage", "identity", "version"])("does not change the command for invalid background %s", async kind => {
  const view = mount();
  if (kind === "storage") transport.read.mockRejectedValueOnce(new Error("storage"));
  else transport.read.mockResolvedValueOnce({ ...initial, ...(kind === "identity" ? { projectId: "foreign" } : { version: NaN }) });
  await act(() => view.result.current.readInBackground()); expect(view.result.current.phase).toBe("idle"); expect(view.result.current.task).toEqual(initial); expect(transport.patch).not.toHaveBeenCalled();
});

it("retains the greatest observed version until an explicit recovery is fresh enough", async () => {
  const view = mount(); transport.read.mockResolvedValueOnce({ ...initial, version: 9 }); await act(() => view.result.current.readInBackground());
  await act(() => view.result.current.readInBackground()); await act(() => view.result.current.refresh());
  expect(view.result.current.phase).toBe("readFailed"); expect(view.result.current.task.version).toBe(7); expect(view.result.current.generation).toBe(0);
  transport.read.mockResolvedValueOnce({ ...initial, version: 9 }); await act(() => view.result.current.refresh());
  expect(view.result.current.phase).toBe("idle"); expect(view.result.current.task.version).toBe(9); expect(view.result.current.generation).toBe(1);
});
it("keeps stale drafts blocked when the in-flight command is explicitly rejected", async () => {
  const write = deferred<void>(); transport.patch.mockImplementationOnce(() => write.promise.then(() => { throw Object.assign(new Error("validation"), { status: 422 }); }));
  const view = mount(); act(() => view.result.current.save("task", { title: "Draft" })); await act(() => view.result.current.readInBackground());
  await act(() => write.resolve()); expect(view.result.current.phase).toBe("conflict");
  act(() => view.result.current.save("task", { title: "Another" })); expect(transport.patch).toHaveBeenCalledOnce(); expect(view.result.current.task.version).toBe(7);
});
it("ignores a background response completed after this task scope unmounts", async () => {
  const response = deferred<TaskType>(); transport.read.mockReturnValueOnce(response.promise); const view = mount(); let pending!: Promise<void>;
  act(() => { pending = view.result.current.readInBackground(); }); view.unmount();
  await act(async () => { response.resolve({ ...initial, version: 9 }); await pending; });
  expect(view.result.current.phase).toBe("idle"); expect(view.result.current.task.version).toBe(7); expect(transport.patch).not.toHaveBeenCalled();
});

it("keeps colleague advancement above the proven own ACK behind explicit conflict recovery", async () => {
  const write = deferred<{ taskId: string; projectId: string; version: number }>(); transport.patch.mockReturnValueOnce(write.promise);
  const view = mount(); act(() => view.result.current.save("task", { title: "Draft" }));
  transport.read.mockResolvedValue({ ...initial, version: 9, title: "Colleague after own write" });
  await act(() => view.result.current.readInBackground()); await act(() => write.resolve({ taskId: "task", projectId: "project", version: 8 }));
  expect(view.result.current.phase).toBe("conflict"); expect(view.result.current.generation).toBe(0); expect(transport.patch).toHaveBeenCalledOnce();
  act(() => view.result.current.save("task", { title: initial.title, description: "Other dirty draft" })); expect(transport.patch).toHaveBeenCalledOnce();
});
it("does not silently advance drafts when the authoritative post-write read is newer than its ACK", async () => {
  const view = mount(); transport.read.mockResolvedValue({ ...initial, version: 9 });
  await act(() => view.result.current.save("task", { title: "Draft" })); expect(view.result.current.phase).toBe("conflict");
  act(() => view.result.current.save("task", { title: initial.title, description: "Other dirty draft" })); expect(transport.patch).toHaveBeenCalledOnce();
});
it.each([7, 9])("does not clear stale with an unproven or noop ACK.version=%s", async version => {
  const write = deferred<{ taskId: string; projectId: string; version: number }>(); transport.patch.mockReturnValueOnce(write.promise);
  const view = mount(); act(() => view.result.current.save("task", { title: "Draft" }));
  transport.read.mockResolvedValue({ ...initial, version: 9 }); await act(() => view.result.current.readInBackground());
  await act(() => write.resolve({ taskId: "task", projectId: "project", version })); expect(view.result.current.phase).toBe("conflict");
});

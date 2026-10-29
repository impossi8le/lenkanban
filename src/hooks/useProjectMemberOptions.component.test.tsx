import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ fetch: vi.fn(), listeners: new Map<string, Set<(data?: { projectId?: string }) => void>>() }));
vi.mock("@/lib/api", () => ({ apiFetch: boundary.fetch }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } }, status: "authenticated" }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({
  on: (name: string, handler: (data?: { projectId?: string }) => void) => {
    const handlers = boundary.listeners.get(name) ?? new Set(); handlers.add(handler); boundary.listeners.set(name, handlers);
  },
  off: (name: string, handler: (data?: { projectId?: string }) => void) => boundary.listeners.get(name)?.delete(handler),
}) }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: ({ projectMembers = [] }: { projectMembers?: Array<{ userId: string; user: { name: string } }> }) =>
  <div data-testid="filter-members">{projectMembers.map(member => <span key={member.userId}>{member.user.name}</span>)}</div> }));
vi.mock("@/components/views/BulkActionsToolbar", () => ({ BulkActionsToolbar: () => null }));
vi.mock("react-big-calendar", () => ({ dateFnsLocalizer: () => ({}), Calendar: () => <div>Calendar body</div> }));
import { useProjectMemberOptions, useProjectMemberRoster, toProjectMemberOptions, type ProjectMemberRoster } from "./useProjectMemberOptions";
import { TableView } from "@/components/views/TableView";
import { CalendarView } from "@/components/views/CalendarView";
import { AssigneeSelector } from "@/components/task/AssigneeSelector";

let client: QueryClient;
const owner = { id: "owner", name: "Владелец", email: "owner@example.test" };
const colleague = { id: "member", name: "Сотрудник", email: "member@example.test" };
const roster: ProjectMemberRoster = { owner, items: [{ user: owner }, { user: colleague }] };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
function emit(name: string, data?: { projectId?: string }) { for (const handler of boundary.listeners.get(name) ?? []) handler(data); }
beforeEach(() => {
  boundary.fetch.mockReset().mockResolvedValue(roster); boundary.listeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["tasks", "board"], []);
  client.setQueryData(["columns", "board"], [{ id: "new", name: "Новые" }]);
  client.setQueryData(["tags", "board"], []);
  client.setQueryData(["task-status-permission", "actor", "board"], { canChangeStatus: true, canAssign: true });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

it.each([
  { kind: "table", first: "view" }, { kind: "table", first: "assignee" },
  { kind: "calendar", first: "view" }, { kind: "calendar", first: "assignee" },
])("keeps one canonical object and one GET for $kind with $first mounted first", async ({ kind, first }) => {
  const View = kind === "table" ? TableView : CalendarView;
  const view = <View projectId="board" onTaskClick={vi.fn()} />;
  const assignee = <AssigneeSelector projectId="board" taskId="task" selectedAssignees={[]} onAssigneesChange={vi.fn()} />;
  const scene = render(wrapper({ children: first === "view" ? view : assignee }));
  await waitFor(() => expect(client.getQueryData(["project-members", "board"])).toEqual(roster));
  scene.rerender(wrapper({ children: first === "view" ? <>{view}{assignee}</> : <>{assignee}{view}</> }));
  await waitFor(() => expect(screen.getByTestId("filter-members")).toHaveTextContent("ВладелецСотрудник"));
  fireEvent.click(screen.getByRole("button", { name: "Исполнители" }));
  expect(await screen.findByRole("option", { name: /Сотрудник/ })).toBeInTheDocument();
  expect(client.getQueryData(["project-members", "board"])).toEqual(roster);
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
  expect(boundary.fetch).toHaveBeenCalledWith("/api/projects/board/members", { signal: expect.any(AbortSignal) });
});

it("deduplicates option identities without changing the canonical source object", () => {
  const result = toProjectMemberOptions(roster);
  expect(result.map(item => item.userId)).toEqual(["owner", "member"]);
  expect(result[0].user.name).toBe("Владелец");
  expect(roster.items).toHaveLength(2);
  expect(toProjectMemberOptions({ owner: null, items: [] })).toEqual([]);
  expect(toProjectMemberOptions({ owner: null, items: [{ user: { ...colleague, name: null } }] })[0].user.name).toBe(colleague.email);
});

it("refreshes all observers once per event turn, reconciles identifier-less PATCH events and ignores other projects", async () => {
  const hooks = renderHook(() => ({ options: useProjectMemberOptions("board"), roster: useProjectMemberRoster("board") }), { wrapper });
  await waitFor(() => expect(hooks.result.current.options.data).toHaveLength(2));
  const invalidations = vi.spyOn(client, "invalidateQueries");
  boundary.fetch.mockResolvedValue({ owner, items: [] });
  act(() => { emit("project:members:updated", { projectId: "other" }); });
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
  await act(async () => { emit("project:members:updated", { projectId: "board" }); emit("project:member:deleted", { projectId: "board" }); });
  await waitFor(() => expect(hooks.result.current.options.data).toHaveLength(1));
  expect(boundary.fetch).toHaveBeenCalledTimes(2);
  expect(invalidations).toHaveBeenCalledTimes(3); // canonical, legacy manager, task collection
  expect(invalidations).toHaveBeenCalledWith({ queryKey: ["projectMembers", "board"], exact: true });
  await act(async () => { emit("project:members:updated"); });
  await waitFor(() => expect(boundary.fetch).toHaveBeenCalledTimes(3));
  hooks.unmount();
  expect([...boundary.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it("does not fetch or subscribe for a disabled observer and aborts a pending GET when its last observer leaves", async () => {
  let signal: AbortSignal | undefined;
  boundary.fetch.mockImplementation((_url: string, options: RequestInit) => { signal = options.signal as AbortSignal; return new Promise(() => {}); });
  const disabled = renderHook(() => useProjectMemberOptions("board", false), { wrapper });
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.listeners.size).toBe(0);
  disabled.unmount();
  const pending = renderHook(() => useProjectMemberOptions("board"), { wrapper });
  await waitFor(() => expect(signal).toBeDefined());
  pending.unmount();
  expect(signal?.aborted).toBe(true);
});

it("keeps access denial as an error and never invents roster options", async () => {
  boundary.fetch.mockRejectedValue(Object.assign(new Error("Denied"), { status: 403 }));
  const hook = renderHook(() => useProjectMemberOptions("board"), { wrapper });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();
  expect(client.getQueryData(["project-members", "board"])).toBeUndefined();
});

import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssigneeSelector } from "./AssigneeSelector";
import { TagPicker } from "./TagPicker";

const transport = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    socket: {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
    },
  };
});
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "operator" } } }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => transport.socket }));
vi.mock("sonner", () => ({ toast: notices }));

const SECRET = "synthetic-selector-private-value-46";
const owner = { id: "owner", name: SECRET, email: `${SECRET}@example.invalid`, avatarUrl: null };
const tag = { id: "tag", name: SECRET, color: "#ef4444" };
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
  transport.listeners.clear();
  notices.success.mockClear();
  notices.error.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
function failure() {
  return Response.json({ error: { message: SECRET, response: { nested: { privateValue: SECRET } } } }, { status: 500 });
}
function expectNoConsoleValues() {
  for (const spy of [log, warn, error]) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    expect(spy).not.toHaveBeenCalled();
  }
}

it("does not log member payloads, selected users, removal, mutation failures or listener cleanup", async () => {
  let changes = 0;
  fetchMock.mockImplementation(async (_url, options) => {
    if (String(_url).endsWith("/task-permissions")) return Response.json({ success: true, data: { canChangeStatus: true } });
    if (options?.method === "PUT") return ++changes === 1 ? Response.json({ success: true, data: {} }) : failure();
    return Response.json({ success: true, data: { owner, items: [] } });
  });
  function Harness() {
    const [selected, setSelected] = useState<Parameters<typeof AssigneeSelector>[0]["selectedAssignees"]>([]);
    return <AssigneeSelector projectId="project" taskId="task" selectedAssignees={selected} onAssigneesChange={setSelected} />;
  }
  const view = mount(<Harness />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Исполнители" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(SECRET) }));
  await waitFor(() => expect(notices.success).toHaveBeenCalledWith("Исполнители обновлены"));
  await user.click(screen.getByRole("button", { name: `Убрать исполнителя: ${SECRET}` }));
  await waitFor(() => expect(notices.error).toHaveBeenCalledWith("Не удалось обновить исполнителей", expect.any(Object)));
  // A rejected removal must preserve the previously committed assignee.
  expect(screen.getByRole("button", { name: `Убрать исполнителя: ${SECRET}` })).toBeInTheDocument();
  await act(async () => {
    for (const event of ["project:members:updated", "project:member:deleted"]) {
      for (const listener of transport.listeners.get(event) ?? []) {
        listener({ user: owner, nested: { privateValue: SECRET } });
      }
    }
  });
  view.unmount();
  expectNoConsoleValues();
});

it.each([false, true])("does not log tag names or nested errors during selection and create failure=%s", async fails => {
  fetchMock.mockImplementation(async (_url, options) => {
    if (options?.method === "PUT") return failure();
    if (options?.method === "POST") return fails ? failure() : Response.json({ success: true, data: { ...tag, id: "created" } });
    return Response.json({ success: true, data: [tag] });
  });
  function Harness() {
    const [selected, setSelected] = useState<Array<{ tag: typeof tag }>>([]);
    return <TagPicker projectId="project" taskId="task" selectedTags={selected} onTagsChange={setSelected} />;
  }
  const view = mount(<Harness />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Теги" }));
  await user.click(await screen.findByRole("option", { name: SECRET }));
  await waitFor(() => expect(notices.error).toHaveBeenCalledWith("Не удалось обновить теги задачи", expect.objectContaining({ description: SECRET })));
  await user.click(screen.getByRole("button", { name: "Создать новый тег" }));
  await user.type(screen.getByRole("textbox", { name: "Название" }), SECRET);
  await user.click(screen.getByRole("button", { name: "Создать" }));
  if (fails) {
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith("Не удалось создать тег", expect.objectContaining({ description: SECRET })));
    expect(screen.getByRole("textbox", { name: "Название" })).toHaveValue(SECRET);
  } else {
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith("Тег создан"));
  }
  view.unmount();
  expectNoConsoleValues();
});

it.each([false, "error"])("does not expose assignment or fetch members when permission=%s", async permission => {
  const changed = vi.fn();
  fetchMock.mockImplementation(async url => {
    if (!String(url).endsWith("/task-permissions")) throw new Error("Members must not load without permission");
    return permission === "error" ? failure() : Response.json({ success: true, data: { canChangeStatus: false } });
  });
  mount(<AssigneeSelector projectId="project" taskId="task" selectedAssignees={[]} onAssigneesChange={changed} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("button", { name: /Исполнители/ })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/task-permissions"))).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  expectNoConsoleValues();
});

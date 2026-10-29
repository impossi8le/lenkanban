import { useState, type FormEvent } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssigneeSelector } from "./AssigneeSelector";
import { TagPicker } from "./TagPicker";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "operator" } } }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({ on: vi.fn(), off: vi.fn() }) }));

const owner = { id: "owner", name: `ДлинноеИмя${"Участника".repeat(20)}`, email: "owner@example.invalid", avatarUrl: null };
const tag = { id: "tag", name: `ДлинныйТег${"БезПробелов".repeat(20)}`, color: "#ef4444" };
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, options) => Response.json({ success: true,
    data: String(url).endsWith("/task-permissions") ? { canChangeStatus: true } : options?.method === "PUT" ? {} : String(url).endsWith("/members") ? { owner, items: [] } : [tag],
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

function mount(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method && options.method !== "GET");

it.each(["{Enter}", " "])("opens tag creation with %s without selecting a tag, exposes colors and restores focus", async key => {
  const changed = vi.fn();
  mount(<TagPicker projectId="project" taskId="task" selectedTags={[]} onTagsChange={changed} />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Теги" });
  await user.click(trigger);
  await screen.findByRole("option", { name: new RegExp("ДлинныйТег") });
  const create = screen.getByRole("button", { name: "Создать новый тег" });
  await user.tab();
  expect(create).toHaveFocus();
  await user.keyboard(key);
  const input = screen.getByRole("textbox", { name: "Название" });
  expect(input).toHaveFocus();
  expect(changed).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(0);
  const firstColor = screen.getByRole("button", { name: "Цвет #ef4444" });
  const nextColor = screen.getByRole("button", { name: "Цвет #f97316" });
  expect(firstColor).toHaveAttribute("aria-pressed", "true");
  nextColor.focus();
  await user.keyboard(" ");
  expect(nextColor).toHaveAttribute("aria-pressed", "true");
  expect(firstColor).toHaveAttribute("aria-pressed", "false");
  await user.click(screen.getByRole("button", { name: "Вернуться к тегам" }));
  expect(screen.getByRole("button", { name: "Создать новый тег" })).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Поиск тегов" })).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  expect(writes()).toHaveLength(0);
});

it("returns focus from Cancel to the keyboard creation action", async () => {
  mount(<TagPicker projectId="project" taskId="task" selectedTags={[]} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Теги" }));
  await user.click(await screen.findByRole("button", { name: "Создать новый тег" }));
  await user.type(screen.getByRole("textbox", { name: "Название" }), "Несохранённый синтетический тег");
  await user.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.getByRole("button", { name: "Создать новый тег" })).toHaveFocus();
  expect(writes()).toHaveLength(0);
});

it("names removal of a long-name assignee and keeps the existing one-user removal payload", async () => {
  const changed = vi.fn();
  const submitted = vi.fn((event: FormEvent) => event.preventDefault());
  function Harness() {
    const [selected, setSelected] = useState<Parameters<typeof AssigneeSelector>[0]["selectedAssignees"]>([{ id: "assignment", user: owner }]);
    return <form onSubmit={submitted}><AssigneeSelector projectId="project" taskId="task" selectedAssignees={selected} onAssigneesChange={next => { changed(next); setSelected(next); }} /></form>;
  }
  mount(<Harness />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Исполнители/ }));
  const remove = await screen.findByRole("button", { name: `Убрать исполнителя: ${owner.name}` });
  await user.tab();
  expect(remove).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(changed).toHaveBeenCalledWith([]);
  expect(writes()[0][0]).toBe("/api/tasks/task/assignees");
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ userIds: [] });
  expect(submitted).not.toHaveBeenCalled();
});

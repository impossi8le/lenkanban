import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ProjectMembersDialog } from "./ProjectMembersDialog";
import { BoardOptionsMenu } from "@/components/kanban/BoardOptionsMenu";

const { apiFetch, apiPost, apiPatch, toast } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", () => ({ apiFetch, apiPost, apiPatch }));
vi.mock("sonner", () => ({ toast }));

const owner = { id: "owner-1", name: "Владелец", email: "owner@example.test", avatarUrl: null, globalRole: "ADMIN" };
const memberUser = { id: "user-1", name: "Алексей", email: "alex@example.test", avatarUrl: null, globalRole: "USER" };
const candidate = { id: "user-2", name: "Мария", email: "maria@example.test", avatarUrl: null, globalRole: "USER" };
const membership = { id: "member-1", role: "MEMBER", createdAt: "2026-10-21T09:00:00.000Z", user: memberUser, addedBy: null };
const members = { projectId: "project-test", ownerId: owner.id, owner, items: [membership] };
const clients: QueryClient[] = [];
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

function mount(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onOpenChange = vi.fn();
  render(<QueryClientProvider client={client}><ProjectMembersDialog open canManage={canManage} onOpenChange={onOpenChange} projectId="project-test" /></QueryClientProvider>);
  return { onOpenChange };
}
async function selectRole(label: string, role: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: role }));
}
async function selectCandidate() {
  const search = await screen.findByRole("textbox", { name: "Выбрать пользователя" });
  fireEvent.click(search);
  fireEvent.click(await screen.findByRole("button", { name: /Мария.*maria@example\.test/ }));
  expect(search).toHaveValue(candidate.name);
}
beforeEach(() => {
  apiFetch.mockReset(); apiPost.mockReset(); apiPatch.mockReset(); toast.success.mockReset(); toast.error.mockReset();
  apiFetch.mockImplementation(async (url: string) => url.includes("/members") ? members : [candidate]);
  apiPost.mockResolvedValue({ ...membership, user: candidate });
  apiPatch.mockResolvedValue({ ...membership, role: "PROJECT_ADMIN" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  // Radix still executes real option selection; jsdom does not implement scrolling.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("project members accessible workflows", () => {
  it("shows combined persisted leadership and applicant grounds separately from board access", async () => {
    apiFetch.mockImplementation(async (url: string) => url.includes("/members") ? {
      ...members,
      functionContext: { applicantPolicyConfigured: true, departmentLeadershipAssigned: true, groupLeadershipAssigned: true },
      memberFunctions: [
        { userId: owner.id, leadership: [{ kind: "group", id: "support", name: "Поддержка" }], applicant: { allowed: false, source: "not_in_policy" } },
        { userId: memberUser.id, leadership: [{ kind: "department", id: "it", name: "ИТ" }], applicant: { allowed: true, source: "explicit_user" } },
      ],
    } : [candidate]);
    mount();
    expect(await screen.findByText("Руководитель подразделения: ИТ")).toBeVisible();
    expect(screen.getByText("Руководитель группы: Поддержка")).toBeVisible();
    expect(screen.getByText("Заявитель: назначен явно")).toBeVisible();
    expect(screen.getByText("Не входит в круг заявителей")).toBeVisible();
    expect(screen.getByText("ВЛАДЕЛЕЦ", { exact: true })).toBeVisible();
    expect(screen.queryByText("Наблюдатель", { exact: true })).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled(); expect(apiPatch).not.toHaveBeenCalled();
  });

  it("explicitly shows unconfigured leadership and applicant facts without guessing from a login", async () => {
    apiFetch.mockImplementation(async (url: string) => url.includes("/members") ? {
      ...members,
      items: [{ ...membership, user: { ...memberUser, name: "Руководитель", email: "leader@example.test" } }],
      functionContext: { applicantPolicyConfigured: false, departmentLeadershipAssigned: false, groupLeadershipAssigned: null },
      memberFunctions: [owner.id, memberUser.id].map(userId => ({ userId, leadership: [], applicant: { allowed: null, source: "unconfigured" } })),
    } : [candidate]);
    mount();
    expect(await screen.findByText(/Руководство подразделения: не назначено/)).toBeVisible();
    expect(screen.getAllByText("Круг заявителей не настроен", { exact: true })).toHaveLength(2);
    expect(screen.queryByText(/^Руководитель подразделения:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Заявитель:/)).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled(); expect(apiPatch).not.toHaveBeenCalled();
  });

  it("does not convert unavailable function data into an applicant or leadership grant", async () => {
    mount();
    expect(await screen.findByText(/Фактические функции сотрудников не подтверждены/)).toBeVisible();
    expect(screen.getAllByText("Функция заявителя не подтверждена")).toHaveLength(2);
    expect(screen.queryByText(/^Заявитель:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Руководитель группы:/)).not.toBeInTheDocument();
  });

  it("separates board access from actual group and department membership without inventing applicant or watcher roles", async () => {
    apiFetch.mockImplementation(async (url: string) => url.includes("/members") ? {
      ...members,
      responsibleGroup: { id: "support-group", name: "Поддержка", memberUserIds: [memberUser.id] },
      items: [{ ...membership, user: { ...memberUser, primaryDepartment: { id: "dep-support", name: "ИТ", archivedAt: null } } },
        { ...membership, id: "manager-membership", role: "PROJECT_ADMIN", user: candidate }],
    } : [candidate]);
    mount();
    expect(await screen.findByText("Ответственная группа: Поддержка", { exact: true })).toBeVisible();
    expect(screen.getByText("Подразделение: ИТ")).toBeVisible();
    expect(screen.getByText("Управляющий доской")).toBeVisible();
    expect(screen.queryByText("Заявитель", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Наблюдатель", { exact: true })).not.toBeInTheDocument();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
  it("cancels deferred keyboard focus intent when the selected user is cleared", async () => {
    let resolveSearch!: (value: typeof candidate[]) => void;
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/members")) return Promise.resolve(members);
      if (new URL(url, "https://synthetic.test").searchParams.get("q") === "deferred") {
        return new Promise(resolve => { resolveSearch = resolve; });
      }
      return Promise.resolve([candidate]);
    });
    mount();
    await selectCandidate();
    const search = screen.getByRole("textbox", { name: "Выбрать пользователя" });
    search.focus();
    fireEvent.change(search, { target: { value: "deferred" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/users?q=deferred&take=50"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(await screen.findByText("Загрузка пользователей...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Мария.*maria@example\.test/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Очистить выбор пользователя" }));
    await act(async () => resolveSearch([candidate]));
    const option = await screen.findByRole("button", { name: /Мария.*maria@example\.test/ });
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(option).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Добавить" })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("returns focus to the actual board menu trigger after its member item opens and Escape closes the dialog", async () => {
    function BoardMenuDialog() {
      const [open, setOpen] = useState(false);
      const noop = () => {};
      return <><BoardOptionsMenu canManage onMembers={() => setOpen(true)} onSavedViews={noop} onTemplates={noop} onRecurringTasks={noop} onAutomation={noop} onSettings={noop} onSaveAsTemplate={noop} onColumns={noop} /><ProjectMembersDialog open={open} canManage onOpenChange={setOpen} projectId="project-test" /></>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><BoardMenuDialog /></QueryClientProvider>);
    const trigger = screen.getByRole("button", { name: "Дополнительно" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Участники" }));
    const dialog = await screen.findByRole("dialog", { name: "Участники проекта" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("moves keyboard focus from ArrowDown search to the first result and retains the chosen user", async () => {
    mount();
    const search = await screen.findByRole("textbox", { name: "Выбрать пользователя" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const option = await screen.findByRole("button", { name: /Мария.*maria@example\.test/ });
    await waitFor(() => expect(option).toHaveFocus());
    fireEvent.click(option);
    expect(search).toHaveValue(candidate.name);
    expect(screen.getByRole("button", { name: "Добавить" })).toBeEnabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("closes only the controlled dialog on Escape and restores focus to its opener", async () => {
    function ControlledDialog() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Открыть участников</button><ProjectMembersDialog open={open} canManage onOpenChange={setOpen} projectId="project-test" /></>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><ControlledDialog /></QueryClientProvider>);
    const opener = screen.getByRole("button", { name: "Открыть участников" });
    opener.focus(); fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Участники проекта" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("does not read or expose mutation controls when management is forbidden", () => {
    mount(false);
    expect(screen.getByText("У вас нет доступа.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled(); expect(apiPost).not.toHaveBeenCalled(); expect(apiPatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps controls unavailable until the member query finishes", async () => {
    let resolveMembers!: (value: typeof members) => void;
    apiFetch.mockImplementation((url: string) => url.includes("/members") ? new Promise(resolve => { resolveMembers = resolve; }) : Promise.resolve([candidate]));
    mount();
    expect(screen.getByRole("dialog", { name: "Участники проекта" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Загрузка участников…");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => resolveMembers(members));
    expect(await screen.findByRole("textbox", { name: "Выбрать пользователя" })).toBeInTheDocument();
  });

  it("shows a failed member query without presenting an empty editable member list", async () => {
    apiFetch.mockImplementation(async (url: string) => { if (url.includes("/members")) throw Error("Synthetic unavailable"); return [candidate]; });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить участников.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Участников пока нет.")).not.toBeInTheDocument();
  });

  it("selects a user and role with named controls and preserves the exact add contract", async () => {
    const { onOpenChange } = mount();
    await selectCandidate();
    await selectRole("Роль нового участника", "Администратор");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/projects/project-test/members", { email: candidate.email, role: "PROJECT_ADMIN" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/users?take=100");
    expect(apiPost).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("changes only the targeted existing member role through the existing PATCH contract", async () => {
    mount();
    await screen.findByText(memberUser.name);
    await selectRole(`Роль участника ${memberUser.name}`, "Администратор");
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith("/api/projects/project-test/members/member-1", { role: "PROJECT_ADMIN" }));
    expect(apiPost).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("honors cancellation of removal confirmation before sending the existing DELETE", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    const remove = await screen.findByRole("button", { name: /Удалить участника/ });
    fireEvent.click(remove);
    expect(confirm).toHaveBeenCalledWith(`Удалить ${memberUser.email} из проекта?`);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/projects/project-test/members/member-1", { method: "DELETE" }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains selection and chosen role across pending and failed add, then supports retry", async () => {
    let rejectAdd!: (reason: Error) => void;
    apiPost.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAdd = reject; }));
    const { onOpenChange } = mount();
    await selectCandidate(); await selectRole("Роль нового участника", "Администратор");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Добавление…" })).toBeDisabled();
    await act(async () => rejectAdd(Error("Synthetic rejected")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Не удалось добавить участника", { description: "Synthetic rejected" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Выбрать пользователя" })).toHaveValue(candidate.name);
    expect(screen.getByRole("combobox", { name: "Роль нового участника" })).toHaveTextContent("Администратор");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost.mock.calls[1]).toEqual(apiPost.mock.calls[0]);
  });

  it("clears the selected user through the named clear action without submitting", async () => {
    mount(); await selectCandidate();
    fireEvent.click(screen.getByRole("button", { name: "Очистить выбор пользователя" }));
    expect(screen.getByRole("textbox", { name: "Выбрать пользователя" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Добавить" })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

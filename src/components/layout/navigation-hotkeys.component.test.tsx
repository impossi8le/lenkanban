import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { CommandPalette } from "./command-palette";
import { useState } from "react";
import { CreateTaskDialog } from "@/components/task/CreateTaskDialog";

const mocks = vi.hoisted(() => ({ push: vi.fn(), sidebar: vi.fn(), path: "/projects/p/board", query: "view=calendar&filter=mine&task=old" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => mocks.path, useSearchParams: () => new URLSearchParams(mocks.query) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("next-auth/react",()=>({useSession:()=>({status:"authenticated",data:{user:{id:"actor-1"}}})}));
const clients: QueryClient[] = [];
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function Harness() {
  useGlobalHotkeys({ onToggleSidebar: mocks.sidebar, onOpenCommandPalette: () => document.querySelector<HTMLButtonElement>("[data-command-palette]")?.click() });
  return <><CommandPalette /><input aria-label="Ввод" /><textarea aria-label="Чат" /><div contentEditable suppressContentEditableWarning aria-label="Редактор"><span>Текст редактора</span></div></>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}
function press(key: string, extra: KeyboardEventInit = {}, target: Element = document.body) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  fireEvent(target, event); return event;
}
beforeEach(() => {
  mocks.push.mockReset(); mocks.sidebar.mockReset(); mocks.path = "/projects/p/board"; mocks.query = "view=calendar&filter=mine&task=old";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: [] })));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (previousScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it.each([["1", "board"], ["2", "table"], ["3", "calendar"]])("routes %s to the canonical board URL", (key, view) => {
  mount(); expect(press(key).defaultPrevented).toBe(true);
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/projects/p/board?view=${view}&filter=mine`);
  expect(fetch).not.toHaveBeenCalled();
});
it("N creates only a navigation intent and preserves the current valid view", () => {
  mount(); press("n");
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p/board?view=calendar&filter=mine&create=task");
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["/inbox", "/projects", "/projects/p/settings", "/projects/p/board/extra"])("does not intercept project commands outside supported context %s", path => {
  mocks.path = path; mount();
  for (const key of ["n", "1", "2", "3"]) expect(press(key).defaultPrevented).toBe(false);
  expect(mocks.push).not.toHaveBeenCalled();
});
it("ignores forms, editor descendants, modified/repeated/IME events and open dialogs", () => {
  mount();
  for (const target of [screen.getByLabelText("Ввод"), screen.getByLabelText("Чат"), screen.getByText("Текст редактора")]) {
    for (const key of ["n", "1", "2", "3", "/", "b"]) expect(press(key, {}, target).defaultPrevented).toBe(false);
  }
  for (const extra of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) press("n", extra);
  const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal);
  press("2"); press("/"); modal.remove();
  expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.sidebar).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("slash opens palette and Radix Escape closes it without global fake dismissal", async () => {
  mount(); press("/"); await screen.findByRole("dialog");
  fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.push).not.toHaveBeenCalled();
});
it("supports slash produced with Shift and ignores it while an editor owns focus", async () => {
  mount(); screen.getByLabelText("Чат").focus();
  press("/", { shiftKey: true }); expect(screen.queryByRole("dialog")).toBeNull();
  (document.activeElement as HTMLElement).blur();
  press("/", { shiftKey: true }); await screen.findByRole("dialog");
});
it("Mod+K opens once from the page and stays out of editor input", async () => {
  mount(); const input = screen.getByLabelText("Ввод"); input.focus();
  press("k", { ctrlKey: true, code: "KeyK" }, input); expect(screen.queryByRole("dialog")).toBeNull();
  input.blur(); press("k", { ctrlKey: true, code: "KeyK" });
  await screen.findByRole("dialog"); expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
it("supports strict task-detail context while N remains an intent only", () => {
  mocks.path = "/projects/p/tasks/task-1"; mount(); press("n");
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p/board?view=calendar&filter=mine&create=task");
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps view switching outside the request search", async () => {
  mount(); fireEvent.click(screen.getByRole("button", { name: "Поиск обращений и направлений" }));
  await screen.findByRole("dialog");
  for (const label of ["Доска", "Таблица", "Календарь", "Навигация", "Вид"]) expect(screen.queryByText(label)).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});
it("loads accessible recent requests instead of create and navigation commands", async () => {
  mocks.path = "/inbox"; mount(); fireEvent.click(screen.getByRole("button", { name: "Поиск обращений и направлений" }));
  await screen.findByRole("dialog");
  for (const text of ["Добавить обращение", "Доска", "Таблица", "Календарь", "G D", "G P", "G S", "Новый проект", "Недавние проекты"]) expect(screen.queryByText(text)).toBeNull();
  await screen.findByText("Пока нет доступных вам обращений.");
  expect(fetch).toHaveBeenCalledWith("/api/tasks?limit=8", expect.objectContaining({ credentials: "include" }));
  expect(mocks.push).not.toHaveBeenCalled();
});

it("keeps focus in the real create dialog when the closing palette releases autofocus", async () => {
  mocks.path = "/inbox"; // Explicit callback integration, rather than a mocked route transition.
  function CreateHarness() {
    const [creating, setCreating] = useState(false);
    return <>
      <CommandPalette />
      <button onClick={() => setCreating(true)}>Написать обращение</button>
      <CreateTaskDialog projectId="p" canCreate open={creating} onClose={() => setCreating(false)} />
    </>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><CreateHarness /></QueryClientProvider>);
  const trigger = screen.getByRole("button", { name: "Поиск обращений и направлений" });
  trigger.focus(); fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  const restoreTrigger = vi.spyOn(trigger, "focus");
  fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  restoreTrigger.mockClear();
  fireEvent.click(screen.getByText("Написать обращение"));
  const dialog = await screen.findByRole("dialog", { name: "Обращение в Техподдержку" });
  const title = screen.getByRole("textbox", { name: "Кратко о проблеме" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Поиск обращений и направлений" })).toBeNull());
  // FocusScope dispatches unmount autofocus after its close cleanup timer.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(dialog).toContainElement(title);
  expect(title).toHaveFocus();
  expect(restoreTrigger).not.toHaveBeenCalled();
  fireEvent.keyDown(title, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each([["1", "board"], ["2", "table"], ["3", "calendar"]])("routes view %s from the physical key when the layout produces another character", (digit, view) => {
  mount();
  // Non-Latin layouts can emit a different `key` for the same physical digit.
  expect(press("х", { code: `Digit${digit}` }).defaultPrevented).toBe(true);
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/projects/p/board?view=${view}&filter=mine`);
  expect(fetch).not.toHaveBeenCalled();
});

it("N and slash follow physical keys in a Russian layout", async () => {
  mount();
  expect(press("т", { code: "KeyN" }).defaultPrevented).toBe(true);
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p/board?view=calendar&filter=mine&create=task");
  expect(press(".", { code: "Slash" }).defaultPrevented).toBe(true);
  await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it("keeps shifted N inert while shifted slash still opens the palette", async () => {
  mount();
  press("Т", { code: "KeyN", shiftKey: true });
  expect(mocks.push).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  press(".", { code: "Slash", shiftKey: true });
  await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  expect(mocks.push).not.toHaveBeenCalled();
});

it("Ctrl+K follows the physical key in a Russian layout and stays out of editors", async () => {
  mount();
  const editor = screen.getByLabelText("Чат");
  editor.focus();
  press("л", { code: "KeyK", ctrlKey: true }, editor);
  expect(screen.queryByRole("dialog")).toBeNull();
  editor.blur();
  press("л", { code: "KeyK", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

it("task detail search also excludes view commands", async () => {
  mocks.path = "/projects/p/tasks/task-1"; mount();
  fireEvent.click(screen.getByRole("button", { name: "Поиск обращений и направлений" }));
  await screen.findByRole("dialog");
  expect(screen.queryByText("Таблица")).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

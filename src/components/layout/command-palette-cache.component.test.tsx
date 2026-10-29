// Highlight marks may split text nodes; assert the exact visible combined text,
// including negative privacy/cache assertions, without depending on markup.
const exactText=(text:string)=>(_:string,node:Element|null)=>Boolean(node&&node.textContent===text&&!Array.from(node.children).some(child=>child.textContent===text));
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), actor: "actor-A", status: "authenticated" }));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mocks.toast(...args) } }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: mocks.status, data: { user: { id: mocks.actor } } }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
import { CommandPaletteDialog } from "./command-palette-dialog";

const clients: QueryClient[] = [];
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  mocks.api.mockReset(); mocks.toast.mockReset(); mocks.actor = "actor-A"; mocks.status = "authenticated";
  mocks.api.mockResolvedValue([]);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const triggerRef = { current: null };
  const tree = (open: boolean) => <QueryClientProvider client={client}><CommandPaletteDialog open={open} onOpenChange={vi.fn()} triggerRef={triggerRef} /></QueryClientProvider>;
  const view = render(tree(true));
  return { client, rerender: (open = true) => view.rerender(tree(open)) };
}
function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Найти обращение или направление…"), { target: { value: text } });
}
const searchCalls = () => mocks.api.mock.calls.filter(([url]) => String(url).includes("search="));
const recentCalls = () => mocks.api.mock.calls.filter(([url]) => String(url) === "/api/tasks?limit=8");

it("loads one bounded recent list and rechecks it on reopen", async () => {
  mocks.api.mockImplementation(async (url: string) => url === "/api/tasks?limit=8"
    ? [{ id: "recent", title: "recent accessible request", projectId: "board", project: { name: "Support" } }]
    : []);
  const view = mount();
  await screen.findByText(exactText("recent accessible request"));
  expect(recentCalls()).toHaveLength(1);
  expect(recentCalls()[0][1]).toMatchObject({ credentials: "include" });

  view.rerender(false);
  view.rerender(true);
  await waitFor(() => expect(recentCalls()).toHaveLength(2));
  await screen.findByText(exactText("recent accessible request"));
});

it("shows loading and an honest empty state for recent requests", async () => {
  let finish: (rows: unknown[]) => void = () => {};
  mocks.api.mockImplementation((url: string) => url === "/api/tasks?limit=8"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve([]));
  mount();
  expect(screen.getByText(exactText("Загружаем доступные вам обращения…"))).toBeInTheDocument();
  finish([]);
  await screen.findByText(exactText("Пока нет доступных вам обращений."));
});

it("reloads recent requests for a new actor instead of showing the previous actor's list", async () => {
  mocks.api.mockImplementation(async (url: string) => url === "/api/tasks?limit=8"
    ? [{ id: "t", projectId: "p", title: "actor A recent result" }]
    : []);
  const view = mount();
  await screen.findByText(exactText("actor A recent result"));
  mocks.api.mockImplementation(() => new Promise(() => undefined));
  mocks.actor = "actor-B"; view.rerender();
  expect(screen.queryByText(exactText("actor A recent result"))).not.toBeInTheDocument();
  expect(view.client.getQueryState(["command-recent", "actor-B"])?.fetchStatus).toBe("fetching");
});

it("offers retry when recent requests fail", async () => {
  mocks.api.mockRejectedValueOnce(Object.assign(new Error("fail"), { status: 500 }));
  mount();
  await screen.findByText(exactText("Не удалось загрузить обращения."));
  mocks.api.mockResolvedValueOnce([{ id: "r", title: "request after retry", projectId: "p" }]);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByText(exactText("request after retry"));
});

it("does not flash cached private text while rechecking permission on reopen", async () => {
  mocks.api.mockImplementation(async (url: string) => url.includes("search=") && url.startsWith("/api/tasks")
    ? [{ id: "private", title: "cached private request", projectId: "board", project: { id: "board", name: "Support" } }]
    : []);
  const view = mount(); search("cached");
  await screen.findByText(exactText("cached private request"));
  view.rerender(false);
  let finish: (rows: unknown[]) => void = () => {};
  mocks.api.mockImplementation((url: string) => url.startsWith("/api/tasks?") && url.includes("search=")
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve([]));
  view.rerender(true);
  await waitFor(() => expect(searchCalls()).toHaveLength(4));
  expect(screen.queryByText(exactText("cached private request"))).not.toBeInTheDocument();
  finish([]);
  await waitFor(() => expect(screen.getByText(exactText("Ничего не найдено."))).toBeInTheDocument());
  expect(screen.queryByText(exactText("cached private request"))).not.toBeInTheDocument();
});

it("revalidates access on reopen and uses the lightweight project projection", async () => {
  const view = mount(); search("synthetic");
  await waitFor(() => expect(searchCalls()).toHaveLength(2));
  expect(searchCalls().map(([url]) => url)).toEqual([
    "/api/tasks?search=synthetic", "/api/projects?view=navigation&search=synthetic",
  ]);
  await waitFor(() => expect(view.client.getQueryData(["search", "actor-A", "synthetic"])).toEqual({
    tasks: [], projects: [], failed: false,
  }));
  view.rerender(false); view.rerender(true);
  await screen.findByRole("dialog");
  await waitFor(() => expect(searchCalls()).toHaveLength(4));
});

it.each(["close", "replace", "identity"])("aborts obsolete searches on %s without a failure toast", async action => {
  mocks.api.mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  const view = mount(); search("first");
  await waitFor(() => expect(searchCalls()).toHaveLength(2));
  const signals = searchCalls().map(([, init]) => init.signal as AbortSignal);
  if (action === "close") view.rerender(false);
  if (action === "replace") search("second");
  if (action === "identity") { mocks.actor = "actor-B"; view.rerender(); }
  await waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true));
  if (action === "close") {
    expect((recentCalls()[0][1] as RequestInit).signal?.aborted).toBe(true);
  }
  expect(mocks.toast).not.toHaveBeenCalled();
  if (action !== "close") await waitFor(() => expect(searchCalls()).toHaveLength(4));
});

it("does not search while unauthenticated or while the dialog is closed", async () => {
  mocks.status = "unauthenticated";
  const view = mount(); search("synthetic");
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(searchCalls()).toHaveLength(0);
  expect(recentCalls()).toHaveLength(0);
  view.rerender(false); mocks.status = "authenticated"; view.rerender(false);
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(searchCalls()).toHaveLength(0);
  view.rerender(true);
  await waitFor(() => expect(searchCalls()).toHaveLength(2));
});

it("does not display another actor's warm results", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/tasks") ? [{ id: "t", projectId: "p", title: "actor A private result" }] : []);
  const view = mount(); search("synthetic");
  await screen.findByText(exactText("actor A private result"));
  mocks.api.mockImplementation(() => new Promise(() => undefined));
  mocks.actor = "actor-B"; view.rerender();
  expect(screen.queryByText(exactText("actor A private result"))).not.toBeInTheDocument();
});

it("shows a search failure with retry without relaxing access", async () => {
  mocks.api.mockImplementation(async (url: string) => {
    if (String(url).includes("search=")) throw Object.assign(new Error("fail"), { status: 500 });
    return [];
  });
  mount(); search("synthetic");
  await screen.findByText(exactText("Не удалось выполнить поиск."));
  expect(mocks.toast).toHaveBeenCalledWith("Ошибка поиска задач: 500");
  mocks.api.mockImplementation(async (url: string) => String(url).startsWith("/api/tasks")
    ? [{ id: "found", title: "request after retry", projectId: "p" }]
    : []);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByText(exactText("request after retry"));
});

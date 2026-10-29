import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import { transform } from "lightningcss";

const mocks = vi.hoisted(() => ({ push: vi.fn(), api: vi.fn(), theme: "light" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/inbox", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "synthetic-actor" } } }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: mocks.theme, setTheme: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("@/lib/telemetry/client", () => ({ getBrowserTelemetryClient: () => undefined }));
import { CommandPaletteDialog } from "./command-palette-dialog";

let client: QueryClient;
let styles: HTMLStyleElement | undefined;
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  mocks.push.mockReset(); mocks.api.mockReset(); mocks.api.mockResolvedValue([]); mocks.theme = "light";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); client.clear(); styles?.remove(); styles = undefined;
  if (previousScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
function mount() {
  return render(<QueryClientProvider client={client}><CommandPaletteDialog open onOpenChange={vi.fn()} triggerRef={{ current: null }} /></QueryClientProvider>);
}

it("shows recent accessible requests and no empty command groups", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/tasks")
    ? [{
        id: "recent", title: "Свежее обращение", projectId: "support",
        project: { name: "Техподдержка" }, createdBy: { name: "Анна" },
        request: { state: "IN_PROGRESS" },
      }]
    : []);
  mount();
  const row = await screen.findByRole("option", { name: /Свежее обращение/ });
  expect(row).toHaveTextContent("Техподдержка");
  expect(row).toHaveTextContent("Анна");
  expect(row).toHaveTextContent("В работе");
  expect(screen.getByRole("group", { name: "Недавние обращения" })).toBeInTheDocument();
  expect(screen.getByText("Сначала срочные, затем новые доступные вам обращения.")).toBeInTheDocument();
  for (const text of ["Быстрые действия", "Навигация", "Вид", "Тема", "Настройки", "Добавить обращение", "Главная"]) {
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  }
  expect(mocks.api).toHaveBeenCalledExactlyOnceWith(
    "/api/tasks?limit=8",
    expect.objectContaining({ credentials: "include" }),
  );
  fireEvent.click(row);
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/support/board?task=recent");
});

it("keeps real cmdk ArrowDown/Enter navigation over recent requests", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/tasks")
    ? [
        { id: "recent-1", title: "Первое обращение", projectId: "p1", project: { name: "Отдел" } },
        { id: "recent-2", title: "Второе обращение", projectId: "p2", project: { name: "Отдел" } },
      ]
    : []);
  mount();
  const input = screen.getByRole("combobox", { name: "Поиск обращений и направлений" });
  await waitFor(() => expect(input).toHaveFocus());
  const first = await screen.findByRole("option", { name: /Первое обращение/ });
  const second = screen.getByRole("option", { name: /Второе обращение/ });
  await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
  await userEvent.keyboard("{ArrowDown}");
  expect(second).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/p2/board?task=recent-2");
});

it.each(["light", "dark"])("compiles the integrated header and readable bounded surface for %s", async theme => {
  mocks.theme = theme; mount();
  const dialog = screen.getByRole("dialog", { name: "Поиск обращений и направлений" });
  const input = screen.getByRole("combobox", { name: "Поиск обращений и направлений" });
  const close = screen.getByRole("button", { name: "Закрыть" });
  const list = screen.getByRole("listbox");
  const classes = Array.from(dialog.querySelectorAll<HTMLElement>("[class]")).flatMap(element => Array.from(element.classList));
  const compiler = await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;");
  const css = compiler.build([...classes, ...Array.from(dialog.classList)]);
  styles = document.createElement("style");
  styles.textContent = transform({ filename: "palette.css", code: Buffer.from(css), targets: { chrome: 80 << 16 } }).code.toString()
    + "input:focus-visible { outline: 2px solid blue; box-shadow: 0 0 0 4px blue; }";
  document.head.appendChild(styles);
  // This focused CSS compiler has no app font tokens; use the real 16px input
  // size explicitly so jsdom's length resolver can evaluate focus outlines.
  input.style.fontSize = "16px";
  input.focus();
  expect(getComputedStyle(dialog).maxWidth).toBe("600px");
  const inputStyle = getComputedStyle(input);
  expect(inputStyle.boxShadow).toBe("none");
  expect(inputStyle.outlineStyle).toBe("none");
  expect(css).toContain("height: calc(var(--spacing) * 11)");
  expect(css).toContain("min-height: calc(var(--spacing) * 12)");
  expect(close).toBeInTheDocument();
  expect(list).toHaveClass("overscroll-contain", "max-h-[min(480px,calc(100dvh-10rem))]");
});

it("keeps both result types and their routes while searching long synthetic names", async () => {
  const title = "Очень длинное обращение ".repeat(12);
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/tasks")
    ? [{ id: "task", title, projectId: "support", project: { name: "Техподдержка и ИТ" } }]
    : [{ id: "claims", name: "Претензии клиентов" }]);
  mount(); fireEvent.change(screen.getByRole("combobox"), { target: { value: "synthetic" } });
  const task = await screen.findByRole("option", { name: /Очень длинное обращение/ });
  expect(task).toHaveTextContent("Техподдержка и ИТ");
  expect(screen.getByRole("group", { name: "Обращения" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Направления" })).toBeInTheDocument();
  expect(mocks.api.mock.calls.map(([url]) => String(url)).filter(url => url.includes("search="))).toEqual([
    "/api/tasks?search=synthetic", "/api/projects?view=navigation&search=synthetic",
  ]);
  fireEvent.click(task);
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/support/board?task=task");
});

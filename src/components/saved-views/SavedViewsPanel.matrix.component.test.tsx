import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { SavedViewsPanel } from "./SavedViewsPanel";
import { TableView } from "../views/TableView";

const api = vi.hoisted(() => ({ apiFetch: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/api", () => ({ ...api, apiPatch: vi.fn(), apiDelete: vi.fn() }));

type SavedView = Parameters<ComponentProps<typeof SavedViewsPanel>["onLoadView"]>[0];
const clients: QueryClient[] = [];
const originalWidth = window.innerWidth;

function resize(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  resize(originalWidth);
  vi.resetAllMocks();
});

it.each([320, 360, 768, 1280])("preserves inputs across resizing from %ipx and restores persisted table search/sort", async width => {
  resize(width);
  let persisted: SavedView[] = [];
  api.apiFetch.mockImplementation(async () => persisted);
  api.apiPost.mockImplementation(async (_url: string, data: Omit<SavedView, "id" | "createdById" | "createdAt" | "updatedAt">) => {
    const saved = { ...data, id: "saved", createdById: "actor", createdAt: "2026-10-22", updatedAt: "2026-10-22" };
    persisted = [saved];
    return saved;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(["tasks", "project"], [
    { id: "a", projectId: "project", title: "Match Alpha", priority: "LOW", position: 1 },
    { id: "b", projectId: "project", title: "Match Beta", priority: "LOW", position: 2 },
    { id: "c", projectId: "project", title: "Other", priority: "LOW", position: 3 },
  ]);
  client.setQueryData(["columns", "project"], []);
  client.setQueryData(["project-members", "project"], []);
  client.setQueryData(["tags", "project"], []);

  function SharedView() {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState("position");
    return <>
      <button onClick={() => setOpen(true)}>Saved views</button>
      <button onClick={() => { setSearch(""); setSortBy("position"); }}>Reset</button>
      <TableView projectId="project" onTaskClick={vi.fn()} search={search} onSearchChange={setSearch} sortBy={sortBy} onSortByChange={setSortBy} />
      <SavedViewsPanel open={open} onOpenChange={setOpen} projectId="project" currentViewType="table"
        currentFilters={{ status: null, priority: null, assignee: null, tags: null, search }} currentSortBy={sortBy}
        onLoadView={view => { setSearch(view.filters.search ?? ""); setSortBy(view.sortBy); setOpen(false); }} />
    </>;
  }
  render(<QueryClientProvider client={client}><SharedView /></QueryClientProvider>);
  const search = screen.getByRole("textbox", { name: "Поиск задач в таблице" });
  fireEvent.change(search, { target: { value: "Match" } });
  fireEvent.click(screen.getByRole("button", { name: "Название" }));
  fireEvent.click(screen.getByRole("button", { name: "Название" }));
  resize(width < 640 ? 1280 : 320);
  expect(search).toHaveValue("Match");
  fireEvent.click(screen.getByRole("button", { name: "Saved views" }));
  await screen.findByText("Нет сохраненных представлений");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить текущее представление" }));
  const name = screen.getByLabelText(/^Название$/);
  const description = screen.getByLabelText("Описание (опционально)");
  fireEvent.change(name, { target: { value: "Мой поиск" } });
  fireEvent.change(description, { target: { value: "Несохранённый черновик" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Использовать по умолчанию" }));
  for (const next of [320, 360, 768, 1280, width]) {
    resize(next);
    expect(screen.getByLabelText(/^Название$/)).toBe(name);
    expect(name).toHaveValue("Мой поиск");
    expect(description).toHaveValue("Несохранённый черновик");
    expect(screen.getByRole("checkbox", { name: "Использовать по умолчанию" })).toBeChecked();
  }
  fireEvent.click(screen.getByRole("button", { name: /^Сохранить$/ }));
  await waitFor(() => expect(api.apiPost).toHaveBeenCalledExactlyOnceWith("/api/saved-views", expect.objectContaining({
    filters: { status: null, priority: null, assignee: null, tags: null, search: "Match" },
    sortBy: "title-desc", name: "Мой поиск", description: "Несохранённый черновик", isDefault: true,
  })));
  await screen.findByText("Мой поиск");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(search).toHaveValue("");
  expect(screen.getByText("Other")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Saved views" }));
  fireEvent.click(await screen.findByTitle("Загрузить представление"));
  expect(search).toHaveValue("Match");
  expect(screen.queryByText("Other")).not.toBeInTheDocument();
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  expect(within(rows[0]).getByRole("button", { name: "Match Beta" })).toBeInTheDocument();
  expect(within(rows[1]).getByRole("button", { name: "Match Alpha" })).toBeInTheDocument();
});

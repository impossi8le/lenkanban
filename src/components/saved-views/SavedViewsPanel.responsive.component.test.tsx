import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ apiFetch: vi.fn(), apiPost: vi.fn() }));

vi.mock("@/lib/api", () => ({
  apiFetch: runtime.apiFetch,
  apiPost: runtime.apiPost,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { SavedViewsPanel } from "./SavedViewsPanel";

function mount(props: Partial<ComponentProps<typeof SavedViewsPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SavedViewsPanel
        open
        onOpenChange={vi.fn()}
        projectId="synthetic-project"
        currentViewType="board"
        onLoadView={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  runtime.apiFetch.mockReset().mockResolvedValue([]);
  runtime.apiPost.mockReset();
});

afterEach(() => {
  cleanup();
});

it("bounds the saved views list by the viewport instead of a fixed 400px block", async () => {
  mount();
  await screen.findByText("Нет сохраненных представлений");

  // The sheet is portalled to document.body, not to the render container.
  const scrollArea = document.querySelector(".relative.overflow-hidden") as HTMLElement;
  expect(scrollArea).not.toBeNull();
  expect(scrollArea).toHaveClass("h-[min(400px,calc(100dvh-16rem))]");
  expect(scrollArea).not.toHaveClass("h-[400px]");
});

it("keeps the saved views sheet clear of the mobile safe area", async () => {
  mount();
  await screen.findByText("Нет сохраненных представлений");

  const sheet = screen.getByRole("dialog");
  expect(sheet).toHaveClass("w-full", "overflow-y-auto", "sm:max-w-[540px]");
  expect(sheet).toHaveClass("pb-[max(1.5rem,env(safe-area-inset-bottom))]");
});

it("saves search with the other filters and passes them back when loading a persisted view", async () => {
  const filters = { search: "Task A", status: "TODO", priority: "LOW", assignee: null, tags: ["support"] };
  const saved = {
    id: "view-search", name: "Search view", description: null, projectId: "synthetic-project",
    viewType: "table", filters, sortBy: "title", isDefault: false,
    createdById: "actor", createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
  };
  runtime.apiPost.mockResolvedValue(saved);
  const first = mount({ currentFilters: filters, currentSortBy: "title", currentViewType: "table" });
  await screen.findByText("Нет сохраненных представлений");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить текущее представление" }));
  fireEvent.change(screen.getByLabelText(/^Название$/), { target: { value: saved.name } });
  fireEvent.click(screen.getByRole("button", { name: /^Сохранить$/ }));
  await waitFor(() => expect(runtime.apiPost).toHaveBeenCalledExactlyOnceWith("/api/saved-views", {
    name: saved.name, description: undefined, projectId: saved.projectId,
    viewType: "table", filters, sortBy: "title", isDefault: false,
  }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Сохранить$/ })).not.toBeInTheDocument());
  first.unmount();

  runtime.apiFetch.mockResolvedValue([saved]);
  const onLoadView = vi.fn();
  mount({ onLoadView });
  await screen.findByText(saved.name);
  fireEvent.click(screen.getByTitle("Загрузить представление"));
  expect(onLoadView).toHaveBeenCalledExactlyOnceWith(saved);
  expect(onLoadView.mock.calls[0][0].filters).toEqual(filters);
});

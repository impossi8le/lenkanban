import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch }));

import {
  AdminPagedList,
  adminSearchParams,
  normalizeAdminSearch,
  resetAdminListQueries,
  uniqueById,
  useAdminPager,
} from "./admin-list";

type Row = { id: string; name: string };
const CURSOR = "opaque/+?= cursor&next";
const clients: QueryClient[] = [];

function rows(from: number, to: number): Row[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `row-${from + index}`,
    name: `Row ${String(from + index).padStart(3, "0")}`,
  }));
}

function Harness({
  query,
  pageSizeParam = "limit",
  initialQuery = "",
}: {
  query: string;
  pageSizeParam?: "limit" | "take";
  initialQuery?: string;
}) {
  const client = React.useContext(QueryClientContext);
  const [search, setSearch] = React.useState(initialQuery);
  const normalized = normalizeAdminSearch(search);
  const pager = useAdminPager<Row>({
    key: ["harness", normalized],
    url: "/api/harness",
    params: adminSearchParams(normalized),
    pageSizeParam,
  });
  const rows = uniqueById(pager.data?.pages.flatMap(page => page.items) ?? []);
  return (
    <div>
      <label>
        Поиск
        <input
          aria-label="Поиск"
          value={search}
          onChange={event => {
            const next = normalizeAdminSearch(event.target.value);
            if (next !== normalized) resetAdminListQueries(client!, ["harness", next], { exact: true });
            setSearch(event.target.value);
          }}
        />
      </label>
      <AdminPagedList query={pager} label={query} blocked={false}>
        {rows.map(row => (
          <li key={row.id} data-admin-row>
            {row.name}
          </li>
        ))}
      </AdminPagedList>
    </div>
  );
}

const QueryClientContext = React.createContext<QueryClient | null>(null);

function mount(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(client);
  render(<QueryClientContext.Provider value={client}><QueryClientProvider client={client}>{element}</QueryClientProvider></QueryClientContext.Provider>);
  return client;
}

function parsed(url: string) {
  return new URL(url, "http://localhost");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetch.mockImplementation(async (url: string) => {
    const params = parsed(url).searchParams;
    if (params.get("q") === "needle") return { items: rows(900, 900), nextCursor: null };
    if (params.has("cursor")) return { items: rows(49, 50), nextCursor: null };
    return { items: rows(0, 49), nextCursor: CURSOR };
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe("shared administrator list contract", () => {
  it("sends one page size parameter, omits an empty search and follows the opaque cursor without duplicates", async () => {
    mount(<Harness query="Все строки" />);
    await screen.findByText("Row 000");
    expect(parsed(mocks.fetch.mock.calls[0][0]).searchParams.get("limit")).toBe("50");
    expect(parsed(mocks.fetch.mock.calls[0][0]).searchParams.has("q")).toBe(false);
    expect(parsed(mocks.fetch.mock.calls[0][0]).searchParams.has("cursor")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё: Все строки" }));
    await screen.findByText("Row 050");
    const second = parsed(mocks.fetch.mock.calls[1][0]).searchParams;
    expect(second.get("cursor")).toBe(CURSOR);
    expect(second.get("limit")).toBe("50");
    expect(screen.getAllByText("Row 049")).toHaveLength(1);
    expect(within(screen.getByLabelText("Все строки")).getAllByRole("listitem")).toHaveLength(51);
    expect(screen.getByRole("button", { name: "Всё загружено: Все строки" })).toBeDisabled();
  });

  it("uses the legacy take parameter when the endpoint requires it", async () => {
    mount(<Harness query="Legacy" pageSizeParam="take" />);
    await screen.findByText("Row 000");
    const params = parsed(mocks.fetch.mock.calls[0][0]).searchParams;
    expect(params.get("take")).toBe("50");
    expect(params.has("limit")).toBe(false);
  });

  it("normalizes and omits a whitespace-only filter, and starts a changed filter from page one", async () => {
    const client = mount(<Harness query="Фильтр" />);
    await screen.findByText("Row 000");
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё: Фильтр" }));
    await screen.findByText("Row 050");

    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "  NEEDLE  " } });
    await screen.findByText("Row 900");
    const needleRequest = parsed(mocks.fetch.mock.calls.at(-1)![0]).searchParams;
    expect(needleRequest.get("q")).toBe("needle");
    expect(needleRequest.has("cursor")).toBe(false);

    // Returning to the previous filter cannot reuse its two-page cache.
    await act(async () => { client.removeQueries({ queryKey: ["harness", ""], exact: true }); });
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "   " } });
    await screen.findByText("Row 000");
    const clearedRequest = parsed(mocks.fetch.mock.calls.at(-1)![0]).searchParams;
    expect(clearedRequest.has("q")).toBe(false);
    expect(clearedRequest.has("cursor")).toBe(false);
    expect(screen.queryByText("Row 050")).not.toBeInTheDocument();
  });

  it("normalizes case and trimming once, so equivalent searches share one query key", async () => {
    expect(normalizeAdminSearch("  Mixed CASE  ")).toBe("mixed case");
    expect(adminSearchParams("")).toEqual({});
    expect(adminSearchParams("needle")).toEqual({ q: "needle" });
    expect(uniqueById([{ id: "a" }, { id: "b" }, { id: "a", name: "second" }])).toEqual([
      { id: "a", name: "second" },
      { id: "b" },
    ]);
  });

  it("keeps the load-more control focusable while pending and announces progress", async () => {
    let release!: (value: { items: Row[]; nextCursor: null }) => void;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (parsed(url).searchParams.has("cursor")) {
        return new Promise(resolve => { release = resolve; });
      }
      return { items: rows(0, 49), nextCursor: CURSOR };
    });
    mount(<Harness query="Фокус" />);
    await screen.findByText("Row 000");
    const more = screen.getByRole("button", { name: "Загрузить ещё: Фокус" });
    more.focus();
    fireEvent.click(more);
    const pending = await screen.findByRole("button", { name: "Загрузка: Фокус…" });
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).not.toBe(document.body);
    await act(async () => release({ items: rows(50, 50), nextCursor: null }));
    await screen.findByText("Row 050");
    await waitFor(() => expect(screen.getByRole("button", { name: "Всё загружено: Фокус" })).toBeDisabled());
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GlobalCreateRequest } from "./GlobalCreateRequest";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: api }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } } }) }));
vi.mock("@/components/task/CreateTaskDialog", () => ({ CreateTaskDialog: ({ projectId, open }: { projectId: string; open: boolean }) => open ? <div data-testid="create-form">{projectId}</div> : null }));
afterEach(() => { cleanup(); api.mockReset(); });
it("loads authorized directions on demand and replaces chooser with the actual selected form", async () => {
  api.mockResolvedValue({ support: { projectId: "real-support", projectName: "Техподдержка" } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GlobalCreateRequest /></QueryClientProvider>);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Добавить обращение" }));
  fireEvent.click(await screen.findByRole("button", { name: /Написать в Техподдержку/ }));
  expect(await screen.findByTestId("create-form")).toHaveTextContent("real-support");
  expect(screen.queryByRole("heading", { name: "Куда вам нужно обратиться?" })).not.toBeInTheDocument();
  expect(api).toHaveBeenCalledWith("/api/request-directions", { signal: expect.any(AbortSignal) });
});

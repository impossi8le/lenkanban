import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ templates: vi.fn(), creation: vi.fn(), status: "authenticated", role: "ADMIN", actorId: "admin-a" }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: mocks.status, data: { user: { id: mocks.actorId, globalRole: mocks.role } } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: async () => [] }));
vi.mock("@/components/project-templates/ProjectTemplatesPanel", () => ({ ProjectTemplatesPanel: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => { mocks.templates(props); return props.open ? <button onClick={() => props.onOpenChange(false)}>Close templates</button> : null; } }));
vi.mock("@/components/project-templates/BoardCreationDialog", () => ({ BoardCreationDialog: (props: { open: boolean }) => { mocks.creation(props); return props.open ? <p>Creation form</p> : null; } }));
import Page from "./page";
beforeEach(() => { mocks.status = "authenticated"; mocks.role = "ADMIN"; mocks.actorId = "admin-a"; });
afterEach(() => { cleanup(); mocks.templates.mockClear(); mocks.creation.mockClear(); });

it("keeps optional panels out of the mounted route until requested and retains templates after close", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await screen.findByText(/Пока нет проектов/);
    expect(mocks.templates).not.toHaveBeenCalled(); expect(mocks.creation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Шаблоны" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close templates" }));
    await waitFor(() => expect(mocks.templates).toHaveBeenLastCalledWith(expect.objectContaining({ open: false })));
    expect(mocks.creation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Новый проект" }));
    await screen.findByText("Creation form");
  } finally { client.clear(); }
});

it.each(["USER", "MEMBER", "OBSERVER", "BOARD_ADMIN"])("hides all administration entry points for %s", async role => {
  mocks.role = role;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await screen.findByText("Пока нет доступных проектов.");
    expect(screen.queryByRole("button", { name: "Шаблоны" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новый проект" })).not.toBeInTheDocument();
    expect(mocks.templates).not.toHaveBeenCalled(); expect(mocks.creation).not.toHaveBeenCalled();
  } finally { client.clear(); }
});
it.each(["loading", "unauthenticated"])("does not flash admin tools while session is %s even with stale admin data", async status => {
  mocks.status = status;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
    await screen.findByText("Пока нет доступных проектов.");
    expect(screen.queryByRole("button", { name: "Шаблоны" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новый проект" })).not.toBeInTheDocument();
    expect(mocks.templates).not.toHaveBeenCalled(); expect(mocks.creation).not.toHaveBeenCalled();
  } finally { client.clear(); }
});
it("unmounts open dialogs on role revocation and never transfers intent to another administrator", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><Page /></QueryClientProvider>;
  try {
    const view = render(content()); await screen.findByText(/Пока нет проектов/);
    fireEvent.click(screen.getByRole("button", { name: "Шаблоны" })); await screen.findByRole("button", { name: "Close templates" });
    fireEvent.click(screen.getByRole("button", { name: "Новый проект" })); await screen.findByText("Creation form");
    mocks.role = "USER"; view.rerender(content());
    expect(screen.queryByText("Creation form")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Close templates" })).not.toBeInTheDocument();
    mocks.role = "ADMIN"; mocks.actorId = "admin-b"; view.rerender(content());
    expect(screen.getByRole("button", { name: "Новый проект" })).toBeInTheDocument();
    expect(screen.queryByText("Creation form")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Close templates" })).not.toBeInTheDocument();
  } finally { client.clear(); }
});

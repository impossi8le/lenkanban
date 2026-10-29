import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ read: vi.fn(), session: { status: "authenticated", data: { user: { id: "actor-A" } } } }));
const nav = vi.hoisted(() => ({ pathname: "/", replace: vi.fn(), back: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ replace: nav.replace, back: nav.back }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.read }));
vi.mock("@/components/task/TaskCommandPanel", () => ({ TaskCommandPanel: ({ task, onClose }: { task: { title: string }; onClose: () => void }) => <section role="dialog" aria-modal="true" aria-label="Authorized request"><p>{task.title}</p><button onClick={onClose}>Close request</button></section> }));
import { RequestDialogLink, RequestDialogProvider } from "./RequestDialogProvider";
import { MyTaskCommandLoader } from "@/app/(dashboard)/my-tasks/MyTaskCommandLoader";
import { readRequestDetails, requestDetailKey } from "@/lib/request-detail-query";
const clients: QueryClient[] = [];
const task = { id: "task-A", projectId: "project-A", version: 4, title: "Authorized full details" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function mount(destination?: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const tree = () => <QueryClientProvider client={client}><RequestDialogProvider><p>Background home content</p><RequestDialogLink projectId="project-A" taskId="task-A">Recent request</RequestDialogLink>{destination?.()}</RequestDialogProvider></QueryClientProvider>;
  const view = render(tree()); return { ...view, client, rerenderPage: () => view.rerender(tree()) };
}
beforeEach(() => { nav.pathname = "/"; nav.replace.mockReset(); nav.back.mockReset(); mocks.read.mockReset().mockResolvedValue(task); mocks.session.status = "authenticated"; mocks.session.data.user.id = "actor-A"; });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("normal click keeps the background, authorizes details freshly and rereads after reopening", async () => {
  const read = deferred<typeof task>(); mocks.read.mockReturnValueOnce(read.promise);
  mount(); const link = screen.getByRole("link", { name: "Recent request" });
  expect(link).toHaveAttribute("href", "/projects/project-A/tasks/task-A");
  fireEvent.click(link);
  await screen.findByRole("dialog", { name: "Загрузка карточки задачи" });
  expect(screen.getByText("Background home content")).toBeInTheDocument();
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("/api/tasks/task-A?view=details", expect.objectContaining({ method: "GET", cache: "no-store", signal: expect.any(AbortSignal) })));
  await act(async () => read.resolve(task));
  await screen.findByText("Authorized full details");
  fireEvent.click(screen.getByRole("button", { name: "Close request" }));
  await waitFor(() => expect(link).toHaveFocus());
  fireEvent.click(link); await screen.findByText("Authorized full details");
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it("drops the obsolete local card when a related link navigates to another task, leaving only the destination dialog", async () => {
  let destinationMounted = false;
  const view = mount(() => destinationMounted
    ? <section role="dialog" aria-modal="true" aria-label="Intercepted request B">Destination task B</section>
    : null);
  fireEvent.click(screen.getByRole("link", { name: "Recent request" }));
  await screen.findByText("Authorized full details");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);

  // Next.js commits the intercepted /tasks/task-B route before this rerender;
  // the local task-A dialog must yield instead of stacking a second dialog.
  nav.pathname = "/projects/project-A/tasks/task-B";
  destinationMounted = true;
  view.rerenderPage();

  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  expect(screen.getByRole("dialog", { name: "Intercepted request B" })).toHaveTextContent("Destination task B");
  expect(screen.queryByText("Authorized full details")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Authorized request" })).not.toBeInTheDocument();
  expect(nav.pathname).toBe("/projects/project-A/tasks/task-B");
  expect(nav.replace).not.toHaveBeenCalled();
  expect(nav.back).not.toHaveBeenCalled();
});

it("shows an already failed click-prefetch without repeating it when the editor chunk mounts", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const selection = { actorId: "actor-A", projectId: "project-A", taskId: "task-A", openId: 1 };
  mocks.read.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 403 }));
  await client.prefetchQuery({ queryKey: requestDetailKey(selection), queryFn: ({ signal }) => readRequestDetails(selection, signal), retry: false, gcTime: 30_000 });
  render(<QueryClientProvider client={client}><MyTaskCommandLoader selection={selection} onClose={vi.fn()} onDeleted={vi.fn()} onAuthoritativeRead={vi.fn()} /></QueryClientProvider>);
  await screen.findByRole("alert");
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Authorized full details")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Повторить чтение карточки" }));
  await screen.findByText("Authorized full details");
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }])("preserves the real URL for modifier click %j", modifiers => {
  mount(); const link = screen.getByRole("link", { name: "Recent request" });
  expect(fireEvent.click(link, modifiers)).toBe(true);
  expect(link).toHaveAttribute("href", "/projects/project-A/tasks/task-A");
  expect(mocks.read).not.toHaveBeenCalled();
});

it("drops old actor selection and aborts pending authorized reads", async () => {
  const read = deferred<typeof task>(); mocks.read.mockReturnValue(read.promise);
  const view = mount(); fireEvent.click(screen.getByRole("link", { name: "Recent request" }));
  await screen.findByRole("dialog", { name: "Загрузка карточки задачи" });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
  const signal = mocks.read.mock.calls[0][1].signal as AbortSignal;
  act(() => { mocks.session.data.user.id = "actor-B"; view.rerenderPage(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(signal.aborted).toBe(true);
  await act(async () => read.resolve(task));
  expect(screen.queryByText("Authorized full details")).not.toBeInTheDocument();
  expect(view.client.getQueryCache().findAll({ queryKey: ["my-task-details", "actor-A"] })).toHaveLength(0);
});

it("restores focus to the real opener after closing", async () => {
  mount(); const link = screen.getByRole("link", { name: "Recent request" });
  link.focus(); fireEvent.click(link); await screen.findByText("Authorized full details");
  fireEvent.click(screen.getByRole("button", { name: "Close request" }));
  await waitFor(() => expect(link).toHaveFocus());
});

it.each(["loading", "unauthenticated"])("does not open details with stale user data while session is %s", async status => {
  mocks.session.status = status;
  mount(); fireEvent.click(screen.getByRole("link", { name: "Recent request" }));
  await act(async () => { await Promise.resolve(); });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not restore an old actor's opener when identity changes before the close frame", async () => {
  const view = mount(); const link = screen.getByRole("link", { name: "Recent request" });
  fireEvent.click(link); await screen.findByText("Authorized full details");
  const callbacks: FrameRequestCallback[] = [];
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callbacks.push(callback); return callbacks.length; });
  const deliberate = document.createElement("button"); deliberate.textContent = "Other account control"; document.body.append(deliberate);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    act(() => { mocks.session.data.user.id = "actor-B"; view.rerenderPage(); });
    deliberate.focus();
    act(() => { callbacks.forEach(callback => callback(0)); });
    expect(deliberate).toHaveFocus(); expect(link).not.toHaveFocus();
  } finally { deliberate.remove(); frame.mockRestore(); }
});

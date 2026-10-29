import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";

const mocks = vi.hoisted(() => ({ ready: false, session: { status: "authenticated", data: { user: { id: "actor-A" } } }, link: vi.fn(), api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ prefetch, children, ...props }: { prefetch?: boolean; children: ReactNode }) => { mocks.link(prefetch); return <a {...props}>{children}</a>; } }));
vi.mock("next/dynamic", () => ({ default: (_load: unknown, options: { loading: ComponentType }) => function Chunk({ onClose }: { onClose: () => void }) {
  const Loading = options.loading;
  return mocks.ready ? <Loaded onClose={onClose} /> : <Loading />;
} }));
function Loaded({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus(); }, []);
  return <section role="dialog" aria-modal="true" aria-label="Loaded request"><button ref={button} onClick={onClose}>Close loaded request</button></section>;
}
import { RequestDialogLink, RequestDialogProvider } from "./RequestDialogProvider";
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient(); clients.push(client);
  const tree = () => <QueryClientProvider client={client}><RequestDialogProvider><RequestDialogLink projectId="p" taskId="t">Open request</RequestDialogLink></RequestDialogProvider></QueryClientProvider>;
  const view = render(tree()); return { client, rerender: () => view.rerender(tree()) };
}
beforeEach(() => { mocks.ready = false; mocks.session.status = "authenticated"; mocks.session.data.user.id = "actor-A"; mocks.link.mockClear(); mocks.api.mockReset(); mocks.api.mockImplementation(() => new Promise(() => undefined)); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it.each(["button", "escape"])("immediately opens a loading dialog and restores focus when closed by %s before the chunk arrives", async method => {
  mount(); const link = screen.getByRole("link", { name: "Open request" }); link.focus();
  fireEvent.click(link);
  const dialog = screen.getByRole("dialog", { name: "Загрузка карточки задачи" });
  expect(screen.getByRole("status")).toHaveTextContent("Открываем обращение");
  expect(mocks.link).toHaveBeenCalledWith(false);
  if (method === "button") fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  else fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(link).toHaveFocus());
});

it("hands focus to the loaded card without restoring the background opener", async () => {
  const view = mount(); const link = screen.getByRole("link", { name: "Open request" }); link.focus(); fireEvent.click(link);
  act(() => { mocks.ready = true; view.rerender(); });
  const loaded = screen.getByRole("button", { name: "Close loaded request" });
  await waitFor(() => expect(loaded).toHaveFocus());
  expect(link).not.toHaveFocus();
  fireEvent.click(loaded); await waitFor(() => expect(link).toHaveFocus());
});

it("removes a loading card when the account changes, and cannot reveal it when the chunk arrives", () => {
  const view = mount(); fireEvent.click(screen.getByRole("link", { name: "Open request" }));
  act(() => { mocks.session.data.user.id = "actor-B"; view.rerender(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => { mocks.ready = true; view.rerender(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("starts the authorized read while the editor chunk is still loading and cancels it on close", async () => {
  const { client } = mount();
  const link = screen.getByRole("link", { name: "Open request" });
  fireEvent.mouseEnter(link); link.focus();
  expect(mocks.api).not.toHaveBeenCalled();
  fireEvent.click(link);
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
  expect(mocks.ready).toBe(false);
  expect(screen.getByRole("status")).toHaveTextContent("Открываем обращение");
  const [url, init] = mocks.api.mock.calls[0];
  expect(url).toBe("/api/tasks/t?view=details");
  expect(init.cache).toBe("no-store");
  expect(init.signal.aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(init.signal.aborted).toBe(true));
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});

it("does not reuse a previous opening's response, and discards late data after account change", async () => {
  let finishOld!: (value: unknown) => void;
  mocks.api.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const view = mount();
  fireEvent.click(screen.getByRole("link", { name: "Open request" }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
  const oldSignal = mocks.api.mock.calls[0][1].signal;
  act(() => { mocks.session.data.user.id = "actor-B"; view.rerender(); });
  await waitFor(() => expect(oldSignal.aborted).toBe(true));
  await act(async () => finishOld({ id: "t", projectId: "p", version: 1 }));
  expect(view.client.getQueryCache().getAll()).toHaveLength(0);
  fireEvent.click(screen.getByRole("link", { name: "Open request" }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
  expect(view.client.getQueryCache().getAll()[0].queryKey).toEqual(["my-task-details", "actor-B", "p", "t", 2]);
});

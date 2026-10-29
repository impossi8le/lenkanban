import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MobileSidebar } from "./mobile-sidebar";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } }, status: "authenticated" }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/my-tasks" }));
vi.mock("@/hooks/useUnreadCounts", () => ({ useUnreadCounts: () => ({ byProject: {}, total: 0 }) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); });

it("keeps personal navigation, omits removed entries and closes after navigation", async () => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ success: true, data: url === "/api/projects" ? [] : null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><MobileSidebar /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Переключить меню" }));
  const inbox = await screen.findByRole("link", { name: "Мои отправленные обращения" });
  expect(screen.getByRole("link", { name: "Мой день" })).toHaveAttribute("href", "/my-day");
  expect(inbox).toHaveAttribute("href", "/my-tasks?scope=mine");
  expect(inbox).toHaveAttribute("aria-current", "page");
  for (const name of ["Сообщения", "Входящие", "Уведомления", "Аналитика"]) expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  // jsdom cannot perform navigation; let React handle closing before
  // cancelling the browser's default document navigation.
  document.addEventListener("click", event => event.preventDefault(), { once: true });
  fireEvent.click(inbox);
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed"));
});

it("closes an open mobile drawer when the desktop breakpoint becomes active and removes the listener", async () => {
  let listener: (() => void) | undefined;
  const remove = vi.fn();
  const media = { matches: false, media: "(min-width: 768px)", addEventListener: vi.fn((_name: string, callback: () => void) => { listener = callback; }), removeEventListener: remove };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: null })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><MobileSidebar /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Переключить меню" }));
  expect(await screen.findByRole("dialog")).toHaveAttribute("data-state", "open");
  media.matches = true;
  await act(async () => listener?.());
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed"));
  view.unmount();
  expect(remove).toHaveBeenCalledWith("change", listener);
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageDTO } from "@/lib/chat-types";

vi.mock("@/hooks/useTaskChat", () => ({
  useTaskChat: () => ({ socket: null, isConnected: false, isJoined: false, lastError: null }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "viewer", name: "Viewer", email: "viewer@example.invalid" } } }),
}));
import { TaskChatPanel } from "./TaskChatPanel";

let visible: boolean;
let client: QueryClient;
let nextFrame: number;
const frames = new Map<number, FrameRequestCallback>();
const observed = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  this.scrollTop = Number(options.top ?? 0);
});

beforeEach(() => {
  visible = false;
  nextFrame = 0;
  frames.clear();
  observed.clear();
  scroll.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const items: ChatMessageDTO[] = Array.from({ length: 25 }, (_, index) => ({
    id: `message-${index}`, clientId: null, taskId: "visibility-task", authorId: "other",
    author: { id: "other", name: "Другой участник", email: "other@example.invalid", avatarUrl: null },
    contentText: `Синтетическое сообщение ${index + 1}`, attachments: [], mentions: [], reactions: {},
    createdAt: "2026-10-21T10:00:00Z",
  }));
  client.setQueryData(["task-messages", "visibility-task"], { items, nextCursor: null });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-radix-scroll-area-viewport") && visible ? 200 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-radix-scroll-area-viewport") && visible ? 2000 : 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { observed.set(this, { callback, targets: new Set() }); }
    observe(target: Element) { observed.get(this)!.targets.add(target); }
    unobserve(target: Element) { observed.get(this)?.targets.delete(target); }
    disconnect() { observed.delete(this); }
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function mount() {
  return render(<QueryClientProvider client={client}><TaskChatPanel taskId="visibility-task" /></QueryClientProvider>);
}

function resizeViewport(viewport: HTMLElement) {
  const entry: ResizeObserverEntry = {
    target: viewport,
    contentRect: viewport.getBoundingClientRect(),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  for (const [observer, { callback, targets }] of [...observed]) {
    if (targets.has(viewport)) callback([entry], observer);
  }
}

function flushFrames() {
  for (let pass = 0; pass < 3 && frames.size; pass += 1) {
    const queued = [...frames];
    frames.clear();
    for (const [, callback] of queued) callback(performance.now());
  }
}

it("scrolls 25 messages to the latest on first reveal, then preserves an intentional older position", () => {
  const view = mount();
  expect(screen.getByText("Синтетическое сообщение 25")).toBeInTheDocument();
  const viewport = view.container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
  act(() => flushFrames());
  expect(scroll).not.toHaveBeenCalled();

  act(() => { visible = true; resizeViewport(viewport); flushFrames(); });
  expect(scroll).toHaveBeenCalledWith({ top: 2000, behavior: "auto" });
  scroll.mockClear();

  viewport.scrollTop = 400;
  fireEvent.scroll(viewport);
  act(() => { visible = false; resizeViewport(viewport); flushFrames(); });
  fireEvent.scroll(viewport);
  act(() => { visible = true; resizeViewport(viewport); flushFrames(); });
  expect(viewport.scrollTop).toBe(400);
  expect(scroll).not.toHaveBeenCalled();
});

it("cancels pending reveal frames and disconnects its observer when unmounted", () => {
  const view = mount();
  const viewport = view.container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
  act(() => { visible = true; resizeViewport(viewport); });
  expect([...observed.values()].some(entry => entry.targets.has(viewport))).toBe(true);
  view.unmount();
  act(() => flushFrames());
  expect([...observed.values()].some(entry => entry.targets.has(viewport))).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
});

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";

const notices = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
const transport = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const acknowledgements: Listener[] = [];
  const socket = {
    connected: false,
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return socket;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return socket;
    },
    once(event: string, listener: Listener) {
      const once: Listener = (...args) => { socket.off(event, once); listener(...args); };
      return socket.on(event, once);
    },
    emit(event: string, _payload: unknown, ack?: Listener) {
      if (event === "project:join" && ack) acknowledgements.push(ack);
      return socket;
    },
  };
  return {
    socket, listeners, acknowledgements,
    receive(event: string, payload?: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
  };
});
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => transport.socket }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { KanbanBoard } from "./Board";

afterEach(() => {
  cleanup();
  transport.listeners.clear();
  transport.acknowledgements.length = 0;
  transport.socket.connected = false;
  vi.unstubAllGlobals();
});

function ProjectBoard() {
  const { data } = useQuery({
    queryKey: ["project", "p"],
    queryFn: () => apiFetch<{ boardRevision: number }>("/api/projects/p"),
  });
  return <>
    <output aria-label="Board revision">{data?.boardRevision}</output>
    <KanbanBoard projectId="p" dndV2Enabled={false} boardRevision={data?.boardRevision} />
  </>;
}

it("catches up missed board snapshots once after a successful rejoin without writes, a column-refetch loop or reference-data reloads", async () => {
  // Removing join-triggered invalidation leaves the old title, columns and revision visible.
  const task = {
    id: "task", title: "Before disconnect", projectId: "p", columnId: "one",
    priority: "MEDIUM", status: "TODO", position: 1024, version: 1,
    createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z",
    assignees: [], tags: [], _count: { messages: 0 },
  };
  const column = {
    id: "one", projectId: "p", name: "Original column", color: "#3b82f6",
    position: 0, workflowKey: "TODO", createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
  const data: Record<string, unknown> = {
    "/api/tasks?projectId=p&limit=500": [task],
    "/api/projects/p/columns": [column],
    "/api/projects/p/members": [],
    "/api/tags?projectId=p": [],
    "/api/projects/p": { id: "p", boardRevision: 1 },
  };
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    requests.push({ url, method: options?.method ?? "GET" });
    if (!(url in data)) throw new Error(`Unexpected URL: ${url}`);
    return Response.json({ success: true, data: data[url] });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><ProjectBoard /></QueryClientProvider>);
  await screen.findByText("Before disconnect");
  await act(async () => {
    transport.socket.connected = true;
    transport.receive("connect");
    transport.acknowledgements.shift()!({ ok: true });
  });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => {
    transport.socket.connected = false;
    transport.receive("disconnect");
  });

  data["/api/tasks?projectId=p&limit=500"] = [
    { ...task, title: "Changed while offline", version: 2 },
    { ...task, id: "offline-new", title: "Submitted by another actor while offline", createdById: "applicant" },
  ];
  data["/api/projects/p/columns"] = [{ ...column, name: "Renamed while offline" }];
  data["/api/projects/p"] = { id: "p", boardRevision: 9 };
  data["/api/projects/p/members"] = [{ userId: "member", role: "MEMBER", user: { id: "member", name: "New member", email: "member@example.com" } }];
  data["/api/tags?projectId=p"] = [{ id: "tag", name: "New tag", color: "#123456" }];
  const beforeRejoin = requests.length;
  await act(async () => {
    transport.socket.connected = true;
    transport.receive("connect");
  });
  expect(requests).toHaveLength(beforeRejoin);
  expect(screen.getByText("Before disconnect")).toBeVisible();

  await act(async () => transport.acknowledgements.shift()!({ ok: true }));
  await screen.findByText("Changed while offline");
  expect(await screen.findByText("Submitted by another actor while offline")).toBeVisible();
  expect(client.getQueryData(["columns", "p"])).toEqual([expect.objectContaining({ name: "Renamed while offline" })]);
  await waitFor(() => expect(screen.getByLabelText("Board revision")).toHaveTextContent("9"));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  // The rejoin re-reads exactly the three board snapshots. Members and tags are
  // reference data with their own live channels, so they are not refetched here.
  expect(requests.slice(beforeRejoin).map(request => request.url).sort()).toEqual([
    "/api/projects/p",
    "/api/projects/p/columns",
    "/api/tasks?projectId=p&limit=500",
  ]);
  expect(client.getQueryData(["project-members", "p"])).toBeUndefined();
  expect(client.getQueryData(["tags", "p"])).toBeUndefined();

  await act(async () => {
    transport.receive("column:updated", { ...column, name: "Live column update" });
  });
  expect(notices.info).toHaveBeenCalledWith("Колонка обновлена", { description: '"Live column update" обновлена другим пользователем' });
  expect(requests).toHaveLength(beforeRejoin + 3);
  expect(requests.every(request => request.method === "GET")).toBe(true);

  // A suspended tab may miss an event while its socket still reports joined.
  // Returning to the tab must catch up without turning focus into a poll storm.
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  data["/api/tasks?projectId=p&limit=500"] = [
    ...(data["/api/tasks?projectId=p&limit=500"] as typeof task[]),
    { ...task, id: "background-new", title: "Submitted while tab suspended" },
  ];
  const beforeForeground = requests.length;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByText("Submitted while tab suspended");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(requests.slice(beforeForeground).map(request => request.url).sort()).toEqual([
    "/api/projects/p", "/api/projects/p/columns", "/api/tasks?projectId=p&limit=500",
  ]);
  await act(async () => {
    for (let count = 0; count < 5; count += 1) {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  });
  expect(requests).toHaveLength(beforeForeground + 3);
  client.clear();
});

it("aborts both pending board snapshot GETs when the board leaves before they finish", async () => {
  const signals = new Map<string, AbortSignal>();
  vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
    if (!options?.signal) throw new Error("Read request must consume the query abort signal");
    signals.set(url, options.signal);
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /></QueryClientProvider>);
  await waitFor(() => expect(signals.size).toBe(2));
  expect([...signals.keys()].sort()).toEqual(["/api/projects/p/columns", "/api/tasks?projectId=p&limit=500"]);
  view.unmount();
  expect([...signals.values()].every(signal => signal.aborted)).toBe(true);
  expect(client.getQueryData(["tasks", "p"])).toBeUndefined();
  expect(client.getQueryData(["columns", "p"])).toBeUndefined();
  client.clear();
});

it("keeps a shared task GET alive until its last view observer leaves", async () => {
  const signals = new Map<string, AbortSignal>();
  vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
    if (!options?.signal) throw new Error("Missing abort signal");
    signals.set(url, options.signal);
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  });
  function AnotherTaskObserver() {
    useQuery({ queryKey: ["tasks", "p"], queryFn: ({ signal }) => apiFetch("/api/tasks?projectId=p&limit=500", { signal }) });
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /><AnotherTaskObserver /></QueryClientProvider>);
  await waitFor(() => expect(signals.size).toBe(2));
  view.rerender(<QueryClientProvider client={client}><AnotherTaskObserver /></QueryClientProvider>);
  expect(signals.get("/api/projects/p/columns")?.aborted).toBe(true);
  expect(signals.get("/api/tasks?projectId=p&limit=500")?.aborted).toBe(false);
  view.unmount();
  expect(signals.get("/api/tasks?projectId=p&limit=500")?.aborted).toBe(true);
  client.clear();
});

import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const identity = vi.hoisted(() => ({ status: "authenticated", empty: false, pathname: "/projects", user: { id: "actor-A", globalRole: "USER" } }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: identity.status, data: identity.empty ? null : { user: identity.user } }) }));
vi.mock("next/navigation", () => ({ usePathname: () => identity.pathname }));
import { SessionReadBoundary } from "@/components/dashboard/SessionReadBoundary";
import { getMyDayDraftKey, readMyDayDraft, writeMyDayDraft } from "@/features/my-day/my-day-draft";
import {
  QUERY_GC_TIME,
  QUERY_STALE_TIME,
  QueryProvider,
  REFERENCE_STALE_TIME,
  createQueryClient,
  retryQuery,
} from "./query-provider";

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  act(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => { identity.status = "authenticated"; identity.empty = false; identity.pathname = "/projects"; identity.user = { id: "actor-A", globalRole: "USER" }; });

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("query client defaults", () => {
  it("disables window-focus refetch and bounds retries and cache lifetime", () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();

    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.refetchOnMount).toBe(true);
    expect(defaults.queries?.refetchOnReconnect).toBe(true);
    expect(defaults.queries?.staleTime).toBe(QUERY_STALE_TIME);
    expect(defaults.queries?.gcTime).toBe(QUERY_GC_TIME);
    expect(defaults.queries?.retry).toBe(retryQuery);
    expect(defaults.mutations?.retry).toBe(0);
  });

  it("does not retry definitive rejection or cancellation, and bounds transient retries", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(retryQuery(0, Object.assign(new Error("rejected"), { status }))).toBe(false);
    }
    expect(retryQuery(0, new DOMException("cancelled", "AbortError"))).toBe(false);
    for (const error of [new TypeError("network"), Object.assign(new Error("temporary"), { status: 503 })]) {
      expect(retryQuery(0, error)).toBe(true);
      expect(retryQuery(1, error)).toBe(true);
      expect(retryQuery(2, error)).toBe(false);
    }
  });

  it("keeps reference data longer than task data", () => {
    const client = createQueryClient();

    expect(client.getQueryDefaults(["projects"]).staleTime).toBe(REFERENCE_STALE_TIME);
    expect(client.getQueryDefaults(["project", "project-1"]).staleTime).toBe(REFERENCE_STALE_TIME);
    expect(client.getQueryDefaults(["columns", "project-1"]).staleTime).toBe(REFERENCE_STALE_TIME);
    expect(client.getQueryDefaults(["tags", "project-1"]).staleTime).toBe(REFERENCE_STALE_TIME);
    expect(client.getQueryDefaults(["project-members", "project-1"]).staleTime).toBe(REFERENCE_STALE_TIME);
    expect(client.getQueryDefaults(["tasks", "project-1"]).staleTime).toBeUndefined();
    expect(client.getQueryDefaults(["my-tasks", "actor-1"]).staleTime).toBeUndefined();
  });
});

describe("private identity boundary", () => {
  it.each(["actor", "logout"])("clears diary sessionStorage after leaving the diary on %s change", change => {
    sessionStorage.clear();
    const tree = () => <QueryProvider><p>Another application page</p></QueryProvider>;
    const view = render(tree());
    writeMyDayDraft({ actorId: "actor-A", date: "2026-10-29", text: "SYNTHETIC_PRIVATE_DIARY", baseVersion: 1 });
    expect(readMyDayDraft("actor-A", "2026-10-29").value?.text).toBe("SYNTHETIC_PRIVATE_DIARY");
    if (change === "actor") identity.user = { id: "actor-B", globalRole: "USER" };
    else { identity.status = "unauthenticated"; identity.empty = true; }
    view.rerender(tree());
    expect(sessionStorage.getItem(getMyDayDraftKey("actor-A", "2026-10-29"))).toBeNull();
    sessionStorage.clear();
  });

  it("starts private reads once after a cold session resolves, with shell visible throughout", async () => {
    identity.status = "loading"; identity.empty = true;
    const queryFn = vi.fn(async () => "private workspace ready");
    function Probe() {
      const { data } = useQuery({ queryKey: ["project", "cold-board"], queryFn });
      return <p>{data}</p>;
    }
    const tree = () => <QueryProvider><p>public navigation</p><SessionReadBoundary><Probe /></SessionReadBoundary></QueryProvider>;
    const view = render(tree());
    expect(screen.getByText("public navigation")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Подготавливаем рабочее пространство");
    await settle();
    expect(queryFn).not.toHaveBeenCalled();
    identity.status = "authenticated"; identity.empty = false;
    view.rerender(tree());
    await screen.findByText("private workspace ready");
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("shows the public Home while the initial session is unresolved", () => {
    identity.status = "loading"; identity.empty = true; identity.pathname = "/";
    render(<QueryProvider><SessionReadBoundary><p>Куда вам нужно обратиться?</p></SessionReadBoundary></QueryProvider>);
    expect(screen.getByText("Куда вам нужно обратиться?")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reuses warm reads for the same actor, including a session refresh", async () => {
    const queryFn = vi.fn(async () => "same actor data");
    const clients: QueryClient[] = [];
    function Probe() {
      clients.push(useQueryClient());
      const { data } = useQuery({ queryKey: ["shared-project"], queryFn });
      return <p>{data}</p>;
    }
    const tree = (show: boolean) => <QueryProvider>{show ? <Probe /> : null}</QueryProvider>;
    const view = render(tree(true));
    await screen.findByText("same actor data");
    view.rerender(tree(false));
    identity.status = "loading";
    view.rerender(tree(true));
    await screen.findByText("same actor data");
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(new Set(clients).size).toBe(1);
  });

  it.each(["actor", "role", "logout"])("clears private reads and local drafts on %s change", async change => {
    const clients: QueryClient[] = [];
    const queryFn = vi.fn(async () => `private ${identity.user.id}/${identity.user.globalRole}`);
    function Probe() {
      const client = useQueryClient();
      if (!clients.includes(client)) clients.push(client);
      const [draft, setDraft] = useState("");
      const { data } = useQuery({ queryKey: ["project", "same-project"], queryFn });
      return <><p>{data}</p><button onClick={() => setDraft("old private draft")}>{draft || "empty draft"}</button></>;
    }
    const tree = () => <QueryProvider><Probe /></QueryProvider>;
    const view = render(tree());
    await screen.findByText("private actor-A/USER");
    screen.getByRole("button").click();
    await screen.findByText("old private draft");
    if (change === "actor") identity.user = { id: "actor-B", globalRole: "USER" };
    if (change === "role") identity.user = { id: "actor-A", globalRole: "ADMIN" };
    if (change === "logout") identity.status = "unauthenticated";
    view.rerender(tree());
    expect(screen.queryByText("old private draft")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveTextContent("empty draft");
    expect(clients).toHaveLength(2);
    expect(clients[0].getQueryCache().getAll()).toHaveLength(0);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("aborts an old actor's pending read and ignores its late response", async () => {
    let finishOld!: (value: string) => void;
    let oldSignal!: AbortSignal;
    let oldClient!: QueryClient;
    function Probe() {
      const client = useQueryClient();
      const actor = identity.user.id;
      if (actor === "actor-A") oldClient = client;
      const { data } = useQuery({ queryKey: ["tasks", "same-board"],
        queryFn: ({ signal }) => {
          if (actor === "actor-A") { oldSignal = signal; return new Promise<string>(resolve => { finishOld = resolve; }); }
          return Promise.resolve("actor-B only");
        } });
      return <p>{data ?? "loading private data"}</p>;
    }
    const tree = () => <QueryProvider><Probe /></QueryProvider>;
    const view = render(tree());
    await waitFor(() => expect(oldSignal).toBeDefined());
    identity.user = { id: "actor-B", globalRole: "USER" };
    view.rerender(tree());
    await screen.findByText("actor-B only");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finishOld("late actor-A data"));
    expect(screen.queryByText("late actor-A data")).not.toBeInTheDocument();
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("window focus and invalidation", () => {
  it("does not refetch a stale query when the browser tab regains focus", async () => {
    const queryFn = vi.fn(async () => "loaded");
    function Probe() {
      const { data } = useQuery({
        queryKey: ["focus-disabled-probe"],
        queryFn,
        staleTime: 0,
      });
      return <p>{data}</p>;
    }

    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );

    await screen.findByText("loaded");
    expect(queryFn).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");
    await settle();

    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("still allows an explicit per-query focus refetch", async () => {
    const queryFn = vi.fn(async () => "loaded");
    function Probe() {
      const { data } = useQuery({
        queryKey: ["focus-enabled-probe"],
        queryFn,
        staleTime: 0,
        refetchOnWindowFocus: true,
      });
      return <p>{data}</p>;
    }

    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );

    await screen.findByText("loaded");
    expect(queryFn).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("refreshes data when a socket handler invalidates the query", async () => {
    let value = "before";
    const queryFn = vi.fn(async () => value);
    let client: QueryClient | undefined;

    function CaptureClient() {
      client = useQueryClient();
      return null;
    }
    function Probe() {
      const { data } = useQuery({
        queryKey: ["socket-invalidated-probe"],
        queryFn,
        staleTime: Number.POSITIVE_INFINITY,
      });
      return <p>{data}</p>;
    }

    render(
      <QueryProvider>
        <CaptureClient />
        <Probe />
      </QueryProvider>,
    );

    await screen.findByText("before");
    expect(queryFn).toHaveBeenCalledTimes(1);

    value = "after";
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ["socket-invalidated-probe"] });
    });

    await screen.findByText("after");
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});

import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authenticated: true, fail: false }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: auth.authenticated ? "authenticated" : "unauthenticated",
    data: auth.authenticated ? { user: { id: "synthetic-actor" } } : null,
  }),
  SessionProvider: ({ children }: { children: ReactNode }) => {
    if (auth.fail) throw new Error("SYNTHETIC_PROVIDER_FAILURE");
    return children;
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "synthetic-font" }),
  JetBrains_Mono: () => ({ variable: "synthetic-mono" }),
}));
vi.mock("@/providers/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/providers/query-provider", () => ({
  QueryProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/telemetry/http", () => ({ isTelemetryConfigured: () => true }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("sonner", () => ({ Toaster: () => null }));

import RootLayout from "@/app/layout";
import { getBrowserTelemetryClient, resetTelemetrySessionDisable } from "@/lib/telemetry/client";

const fetchMock = vi.fn<typeof fetch>();
let events: Array<Record<string, unknown>> = [];
beforeEach(() => {
  auth.authenticated = true;
  auth.fail = false;
  events = [];
  window.sessionStorage.clear();
  resetTelemetrySessionDisable();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.kind === "session.start") {
      const expiry = Date.now() + 3_600_000;
      return Response.json({ success: true, data: {
        sessionId: body.sessionId,
        sessionToken: `v1.${expiry}.${"0".repeat(64)}`,
        expiresAt: new Date(expiry).toISOString(),
      } });
    }
    events.push(...body.events);
    return Response.json({ success: true, data: {
      accepted: body.events.map((event: { eventId: string }) => event.eventId),
    } });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  getBrowserTelemetryClient()?.dispose();
  resetTelemetrySessionDisable();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Crash() {
  const [broken, setBroken] = useState(false);
  if (broken) throw new Error("SYNTHETIC_PRIVATE_RENDER_FAILURE");
  return <button onClick={() => setBroken(true)}>Crash descendant</button>;
}
async function layoutBody() {
  const layout = await RootLayout({ children: <Crash /> });
  // Keep the actual server-returned provider/boundary JSX; omit only html/body.
  return layout.props.children.props.children;
}
async function setup() {
  const view = render(<>{await layoutBody()}</>);
  const client = getBrowserTelemetryClient()!;
  await waitFor(() => expect(client.getDiagnosticContext().endsWith(":unready")).toBe(false));
  return { view, client };
}

it("the actual layout keeps the inner diagnostic event once and retains logout cleanup", async () => {
  const { view, client } = await setup();
  const identity = vi.spyOn(client, "setIdentity");
  const capture = vi.spyOn(client, "captureRenderFailure");
  fireEvent.click(screen.getByText("Crash descendant"));
  await screen.findByRole("heading", { name: "Что-то пошло не так" });
  const reference = await screen.findByText(/^Код ошибки: /);
  const errorId = reference.textContent!.replace("Код ошибки: ", "").trim();
  expect(errorId).toMatch(/^[a-f0-9-]{36}$/);
  expect(capture).toHaveBeenCalledExactlyOnceWith(errorId);
  await client.flush();
  expect(events.filter(event => event.event === "client.render.failed" && event.errorId === errorId)).toHaveLength(1);
  expect(identity.mock.calls.some(([id]) => id === null)).toBe(false);

  view.rerender(<>{await layoutBody()}</>);
  await client.flush();
  expect(capture).toHaveBeenCalledOnce();
  expect(events.filter(event => event.event === "client.render.failed")).toHaveLength(1);

  const deliveredBeforeLogout = events.length;
  expect(client.recordScreen("board")).toBe(true); // Queue an unsent event.
  auth.authenticated = false;
  view.rerender(<>{await layoutBody()}</>);
  await waitFor(() => expect(identity).toHaveBeenCalledWith(null));
  expect(client.getDiagnosticContext().endsWith(":unready")).toBe(true);
  expect(client.recordScreen("task.detail")).toBe(false);
  await client.flush();
  expect(events).toHaveLength(deliveredBeforeLogout);
  expect(events.filter(event => event.event === "client.render.failed")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("SYNTHETIC_PRIVATE_RENDER_FAILURE");
});

it("the outer boundary still handles failure inside the auth provider with a local reference", async () => {
  const { view, client } = await setup();
  auth.fail = true;
  view.rerender(<>{await layoutBody()}</>);
  await screen.findByRole("heading", { name: "Что-то пошло не так" });
  expect(await screen.findByText(/^Код ошибки: /)).toHaveTextContent(/^Код ошибки: [a-f0-9-]{36}$/);
  expect(screen.queryByText("Crash descendant")).toBeNull();
  expect(client.getDiagnosticContext().endsWith(":unready")).toBe(true);
  await client.flush();
  // Provider failures cannot promise delivery after destroying that provider.
  expect(events.filter(event => event.event === "client.render.failed")).toHaveLength(0);
});

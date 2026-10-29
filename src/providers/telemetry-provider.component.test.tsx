import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), identity: vi.fn(), client: vi.fn(), reset: vi.fn(), screen: vi.fn(), requests: vi.fn(), controls: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: mocks.session }));
vi.mock("@/lib/telemetry/client", () => ({
  getBrowserTelemetryClient: mocks.client,
  resetTelemetrySessionDisable: mocks.reset,
}));
vi.mock("@/lib/telemetry/browser-observers", async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/telemetry/browser-observers')>(),
  observeBrowserRequests: mocks.requests,
  observeControlActivations: mocks.controls,
}));
import { TelemetryProvider } from "./telemetry-provider";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.identity.mockResolvedValue(undefined);
  mocks.requests.mockReturnValue(() => {});
  mocks.controls.mockReturnValue(() => {});
  mocks.client.mockReturnValue({ setIdentity: mocks.identity, recordScreen: mocks.screen });
});
afterEach(cleanup);
function auth(status: "loading" | "authenticated" | "unauthenticated", id?: string) {
  mocks.session.mockReturnValue({ status, data: id ? { user: { id } } : null });
}
function tree(enabled = true) {
  return <TelemetryProvider enabled={enabled}><p>Business UI remains visible</p></TelemetryProvider>;
}

it("never initializes an actor during loading/unauthenticated and leaves children rendered", () => {
  auth("loading");
  const view = render(tree());
  expect(mocks.identity.mock.calls.map(([id]) => id)).toEqual([null]);
  expect(screen.getByText("Business UI remains visible")).toBeInTheDocument();
  auth("unauthenticated");
  view.rerender(tree());
  expect(mocks.identity.mock.calls.every(([id]) => id === null)).toBe(true);
});

it("ordinary rerenders with the same authenticated actor do not repeat initialization", () => {
  auth("authenticated", "actor-A");
  const view = render(tree());
  auth("authenticated", "actor-A");
  view.rerender(tree());
  view.rerender(tree());
  expect(mocks.identity.mock.calls.map(([id]) => id)).toEqual(["actor-A"]);
  view.unmount();
  expect(mocks.identity.mock.calls.map(([id]) => id)).toEqual(["actor-A", null]);
});

it("clears the old context before loading, logout and switching accounts", () => {
  auth("authenticated", "actor-A");
  const view = render(tree());
  auth("loading");
  view.rerender(tree());
  auth("authenticated", "actor-B");
  view.rerender(tree());
  const ids = mocks.identity.mock.calls.map(([id]) => id);
  expect(ids[0]).toBe("actor-A");
  expect(ids.at(-1)).toBe("actor-B");
  expect(ids.slice(1, -1).every(id => id === null)).toBe(true);
  auth("unauthenticated");
  view.rerender(tree());
  expect(mocks.identity.mock.calls.at(-1)?.[0]).toBeNull();
});

it("an authenticated session without a DB user ID cannot initialize analytics", () => {
  auth("authenticated");
  render(tree());
  expect(mocks.identity).toHaveBeenCalledExactlyOnceWith(null);
});

it("a disabled deployment never constructs the telemetry client", () => {
  auth("authenticated", "actor-A");
  render(tree(false));
  expect(mocks.client).not.toHaveBeenCalled();
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
});

it("switching from disabled to enabled starts the session on the next render", () => {
  auth("authenticated", "actor-A");
  const view = render(tree(false));
  expect(mocks.identity).not.toHaveBeenCalled();
  view.rerender(tree(true));
  expect(mocks.reset).toHaveBeenCalledTimes(1);
  expect(mocks.identity).toHaveBeenCalledWith("actor-A");
});

it("observes only a ready authenticated identity and stops both observers on account change", async () => {
  const stopRequests = vi.fn(), stopControls = vi.fn();
  mocks.requests.mockReturnValue(stopRequests);
  mocks.controls.mockReturnValue(stopControls);
  auth('authenticated', 'actor-A');
  const view = render(tree());
  expect(mocks.requests).not.toHaveBeenCalled();
  await act(async () => {});
  expect(mocks.requests).toHaveBeenCalledTimes(1);
  expect(mocks.controls).toHaveBeenCalledTimes(1);
  auth('authenticated', 'actor-B');
  view.rerender(tree());
  expect(stopRequests).toHaveBeenCalledTimes(1);
  expect(stopControls).toHaveBeenCalledTimes(1);
  await act(async () => {});
  expect(mocks.requests).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(stopRequests).toHaveBeenCalledTimes(2);
  expect(stopControls).toHaveBeenCalledTimes(2);
});

it("a late identity initialization cannot install observers after logout", async () => {
  let release: () => void;
  mocks.identity.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  auth('authenticated', 'actor-A');
  const view = render(tree());
  auth('unauthenticated');
  view.rerender(tree());
  await act(async () => { release!(); });
  expect(mocks.requests).not.toHaveBeenCalled();
  expect(mocks.controls).not.toHaveBeenCalled();
});

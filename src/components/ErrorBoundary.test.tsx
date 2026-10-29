// @vitest-environment jsdom
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/telemetry/render-error", () => ({ reportRenderFailure: mocks.report }));
import { ErrorBoundary } from "./ErrorBoundary";
const CODE = "a12bc345-6789-4abc-8def-012345678901";
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.report.mockReturnValue(CODE);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

it("renders healthy children without reporting an error", () => {
  render(<ErrorBoundary><p>Healthy business UI</p></ErrorBoundary>);
  expect(screen.getByText("Healthy business UI")).toBeInTheDocument();
  expect(mocks.report).not.toHaveBeenCalled();
});

it("shows a local error reference and recovery actions without raw message or a delivery promise", async () => {
  const original = new Error("synthetic-private-error-password-cookie");
  function Broken(): React.ReactNode { throw original; }
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(await screen.findByRole("heading", { name: "Что-то пошло не так" })).toBeInTheDocument();
  expect(screen.getByText(`Код ошибки: ${CODE}`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Вернуться на главную" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Перезагрузить страницу" })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/synthetic-private|password|cookie|уведомлен|отправлен|доставлен/i);
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(original);
});

it("keeps recovery UI available when the diagnostic helper cannot produce a reference", async () => {
  mocks.report.mockReturnValue(null);
  function Broken(): React.ReactNode { throw new Error("synthetic-private"); }
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  await screen.findByRole("heading", { name: "Что-то пошло не так" });
  expect(screen.queryByText(/Код ошибки:/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Перезагрузить страницу" })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("synthetic-private");
});

it("does not account a cancelled request as a render failure", async () => {
  const cancelled = Object.assign(new Error("synthetic-private-cancelled"), { name: "AbortError" });
  function Broken(): React.ReactNode { throw cancelled; }
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  await screen.findByRole("heading", { name: "Что-то пошло не так" });
  expect(mocks.report).not.toHaveBeenCalled();
  expect(screen.queryByText(/Код ошибки:/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("synthetic-private");
});

it("still accounts a timeout as a render failure, not a cancellation", async () => {
  const timeout = Object.assign(new Error("synthetic-private-timeout"), { name: "TimeoutError" });
  function Broken(): React.ReactNode { throw timeout; }
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  await screen.findByRole("heading", { name: "Что-то пошло не так" });
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(timeout);
});

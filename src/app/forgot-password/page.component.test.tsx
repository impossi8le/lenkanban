import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecoveryPage from "./page";
vi.mock("next/navigation", () => ({ useSearchParams: () => { throw new Error("MUST_NOT_READ_RECOVERY_TOKEN"); } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("disabled local recovery page", () => {
  it("offers SSO guidance and sign-in only, without collecting or sending secrets", () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState({}, "", "?token=synthetic-private-token&email=synthetic@example.invalid");
    const { container } = render(<RecoveryPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("heading", { name: "Восстановление доступа" })).toBeVisible();
    expect(screen.getByText("Восстановление доступа выполняется через корпоративный SSO.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Вернуться ко входу" })).toHaveAttribute("href", "/sign-in");
    expect(container.querySelector("form, input, textarea")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/synthetic|письмо отправлено|администратор/i);
    expect(container.querySelector('a[href="/forgot-password"], a[href="/reset-password"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

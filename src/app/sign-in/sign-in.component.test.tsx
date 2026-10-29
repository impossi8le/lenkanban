import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SignInPage from "./page";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Sign-in", () => {
  it("keeps local sign-in and registration without offering local password recovery", () => {
    render(<SignInPage />);
    expect(screen.getByLabelText("Логин")).toBeVisible();
    expect(screen.getByLabelText("Пароль")).toBeVisible();
    expect(screen.getByRole("link", { name: "Регистрация" })).toHaveAttribute("href", "/sign-up");
    expect(screen.queryByRole("link", { name: "Забыли пароль?" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/forgot-password"], a[href="/reset-password"]')).toBeNull();
  });
  it("accepts a short login using the browser username field", () => {
    render(<SignInPage />);
    const login = screen.getByLabelText("Логин");
    expect(login).toHaveAttribute("type", "text");
    expect(login).toHaveAttribute("autocomplete", "username");
    expect(login).toHaveAttribute("placeholder", "barhat");
    fireEvent.change(login, { target: { value: "barhat" } });
    expect(login).toBeValid();
  });
  it("links the sign-in error to both credential fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ retryAfter: 60 }, { status: 429 })));
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "pavel@example.com" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "synthetic-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Войти" }).closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "sign-in-error");
    for (const field of [screen.getByLabelText("Логин"), screen.getByLabelText("Пароль")]) {
      expect(field).toHaveAttribute("aria-describedby", "sign-in-error");
      expect(field).toHaveAttribute("aria-invalid", "true");
    }
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SignUpPage from "./sign-up/page";
import ForgotPasswordPage from "./forgot-password/page";
import ResetPasswordPage from "./reset-password/page";
import VerifyEmailPage from "./verify-email/page";

const navigation = vi.hoisted(() => ({
  query: "",
  router: { push: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => navigation.router,
}));

beforeEach(() => {
  navigation.query = "";
  navigation.router.push.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication form states", () => {
  it("keeps registration fields after a rejected request and announces the error", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "EmailAlreadyInUse" }, { status: 409 }));
    render(<SignUpPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Тестовый пользователь" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthetic@example.test" } });
    fireEvent.change(screen.getByLabelText("Пароль (мин. 8 символов)"), { target: { value: "synthetic-passphrase" } });
    fireEvent.submit(screen.getByRole("button", { name: "Создать аккаунт" }).closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Этот email уже используется");
    expect(alert).toHaveAttribute("id", "sign-up-error");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-describedby", "sign-up-error");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).toHaveValue("synthetic@example.test");
    expect(screen.getByLabelText("Имя")).toHaveValue("Тестовый пользователь");
    expect(screen.getByRole("button", { name: "Создать аккаунт" })).toBeEnabled();
  });

  it.each([ForgotPasswordPage, ResetPasswordPage])("renders retired recovery with SSO guidance and no mutation", Page => {
    navigation.query = "token=synthetic-private-token";
    const { container } = render(<Page />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("heading", { name: "Восстановление доступа" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Вернуться ко входу" })).toHaveAttribute("href", "/sign-in");
    expect(container.querySelector("form, input")).toBeNull();
    expect(container.textContent).not.toContain("synthetic-private-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("announces verification loading and provides recovery links after rejection", async () => {
    navigation.query = "token=synthetic-token";
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    render(<VerifyEmailPage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("status")).toHaveTextContent("Проверяем ваш токен");
    resolve(Response.json({ success: false, error: { message: "Тестовая ссылка недействительна" } }, { status: 400 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Тестовая ссылка недействительна");
    expect(screen.getByRole("link", { name: "Вернуться ко входу" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("link", { name: "Зарегистрироваться заново" })).toHaveAttribute("href", "/sign-up");
  });
});

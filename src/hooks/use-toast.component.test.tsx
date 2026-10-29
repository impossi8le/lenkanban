import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster } from "sonner";
import { toast, useToast } from "./use-toast";

class ToastBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>Toast renderer crashed</p> : this.props.children; }
}
function Harness({ destructive = false }: { destructive?: boolean }) {
  const { toast: notify } = useToast();
  return <><button onClick={() => notify({ title: destructive ? "Ошибка сохранения" : "Шаблон сохранён", description: "Описание результата", variant: destructive ? "destructive" : "default" })}>Notify</button><ToastBoundary><Toaster /></ToastBoundary></>;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { act(() => { toast.dismiss(); }); cleanup(); vi.unstubAllGlobals(); });

describe("legacy notification compatibility", () => {
  it("renders object title and description through the real Sonner toaster", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(await screen.findByText("Шаблон сохранён")).toBeInTheDocument();
    expect(screen.getByText("Описание результата")).toBeInTheDocument();
  });
  it("maps destructive notifications to error presentation without rendering the object", async () => {
    render(<Harness destructive />);
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    const title = await screen.findByText("Ошибка сохранения");
    expect(title.closest("[data-sonner-toast]")).toHaveAttribute("data-type", "error");
  });
  it("preserves native JSX messages and Sonner methods", async () => {
    render(<Toaster />);
    act(() => { toast(<strong>Обычное сообщение</strong>, { description: "Native description" }); });
    expect(await screen.findByText("Обычное сообщение")).toBeInTheDocument();
    act(() => { toast.success("Готово"); });
    expect(await screen.findByText("Готово")).toBeInTheDocument();
  });
});

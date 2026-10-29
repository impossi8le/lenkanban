import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRoutePending } from "./TaskRoutePending";
import BoardLoading from "@/app/(dashboard)/projects/[id]/board/loading";
import TaskLoading from "@/app/(dashboard)/projects/[id]/tasks/[taskId]/loading";
import TaskModalLoading from "@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/loading";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("scoped route pending recovery", () => {
  it("wires board, standalone task and intercepted task fallbacks to the correct pending presentation", () => {
    const view = render(<BoardLoading />);
    expect(screen.getByRole("status", { name: "Загрузка доски…" })).toBeInTheDocument();
    view.rerender(<TaskLoading />);
    expect(screen.getByRole("status", { name: "Загрузка карточки задачи…" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Загрузка доски…" })).not.toBeInTheDocument();
    view.rerender(<TaskModalLoading />);
    expect(screen.getByRole("status", { name: "Загрузка карточки задачи…" }).parentElement).toHaveClass("fixed", "inset-0", "z-50");
  });
  it("replaces busy loading with a neutral alert at the deadline and only reloads on request", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    render(<TaskRoutePending />);
    expect(screen.getByRole("status", { name: "Загрузка карточки задачи…" })).toHaveAttribute("aria-busy", "true");
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Загрузка занимает больше времени, чем обычно.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/доступ|403|404|отмен/i);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cleans its timer when navigation finishes, and a fresh wait has its own deadline", () => {
    const first = render(<TaskRoutePending />);
    act(() => vi.advanceTimersByTime(10_000));
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);
    render(<TaskRoutePending variant="board" />);
    expect(screen.getByRole("status", { name: "Загрузка доски…" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

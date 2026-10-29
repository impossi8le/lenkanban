import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Calendar } from "./calendar";

afterEach(cleanup);

it("excludes middle range days from the primary selected-button theme, including hover", () => {
  render(<Calendar mode="range" defaultMonth={new Date(2026, 8, 1)} selected={{ from: new Date(2026, 8, 18), to: new Date(2026, 8, 20) }} />);
  const middle = screen.getByRole("button", { name: /19 сентября 2026.*выбрано/ }).parentElement!;
  const start = screen.getByRole("button", { name: /18 сентября 2026.*выбрано/ }).parentElement!;
  expect(middle).toHaveAttribute("data-selected", "true");
  expect(middle).toHaveClass("day-range-middle", "[&>button]:bg-accent");
  expect(start).not.toHaveClass("day-range-middle");
  for (const cell of [start, middle]) {
    expect(cell).toHaveClass("[&:not(.day-range-middle)>button]:bg-primary", "[&:not(.day-range-middle)>button:hover]:bg-primary");
    expect(cell).not.toHaveClass("[&>button]:bg-primary", "[&>button:hover]:bg-primary");
  }
});

it("keeps seven equal native table columns and styles the actual v9 day buttons", () => {
  render(<Calendar mode="single" defaultMonth={new Date(2026, 8, 1)} selected={new Date(2026, 8, 18)} />);
  const grid = screen.getByRole("grid");
  expect(grid).toHaveClass("table-fixed", "border-collapse");
  for (const header of screen.getAllByRole("columnheader", { hidden: true })) {
    expect(header).toHaveClass("w-9", "text-center");
  }
  for (const cell of screen.getAllByRole("gridcell")) {
    expect(cell).toHaveClass("h-9", "w-9", "p-0");
    expect(cell).not.toHaveClass("inline-flex");
  }
  const selected = screen.getByRole("button", { name: /18 сентября 2026.*выбрано/ });
  expect(selected).toHaveClass("h-9", "w-9", "inline-flex");
  expect(selected.parentElement).toHaveClass("[&:not(.day-range-middle)>button]:bg-primary", "[&:not(.day-range-middle)>button]:text-primary-foreground");
});

it("anchors themed navigation above the grid and can navigate to the next month", () => {
  render(<Calendar mode="single" defaultMonth={new Date(2026, 8, 1)} />);
  const nav = screen.getByRole("navigation");
  expect(nav).toHaveClass("absolute", "inset-x-0", "top-0");
  expect(nav.parentElement).toHaveClass("relative");
  const next = screen.getByRole("button", { name: "Перейти к следующему месяцу" });
  expect(next).toHaveClass("h-7", "w-7");
  expect(next.querySelector("svg")).toHaveClass("fill-current", "h-4", "w-4");
  fireEvent.click(next);
  expect(screen.getByText(/октябрь 2026/i)).toBeInTheDocument();
});

it("renders Russian month, weekdays and navigation accessibility labels by default", () => {
  render(<Calendar mode="single" defaultMonth={new Date(2026, 8, 1)} />);
  expect(screen.getByText(/сентябрь 2026/i)).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader", { hidden: true }).map(header => header.textContent)).toEqual(["пн", "вт", "ср", "чт", "пт", "сб", "вс"]);
  expect(screen.getByRole("button", { name: "Перейти к следующему месяцу" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Перейти к предыдущему месяцу" })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Панель навигации" })).toBeInTheDocument();
});

it("keeps selected/today labels Russian and preserves local date selection", () => {
  const onSelect = vi.fn();
  const date = new Date(2026, 8, 18);
  render(<Calendar mode="single" defaultMonth={date} selected={date} today={date} onSelect={onSelect} />);
  expect(screen.getByRole("button", { name: /Сегодня,.*18 сентября 2026.*выбрано/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /19 сентября 2026/ }));
  const selected = onSelect.mock.calls[0][0] as Date;
  expect([selected.getFullYear(), selected.getMonth(), selected.getDate()]).toEqual([2026, 8, 19]);
});

it("localizes the month/year dropdown accessibility labels", () => {
  render(<Calendar mode="single" defaultMonth={new Date(2026, 8, 1)} captionLayout="dropdown" />);
  expect(screen.getByRole("combobox", { name: "Выберите месяц" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Выберите год" })).toBeInTheDocument();
});

it("keeps disabled days readable instead of fading them out", () => {
  render(
    <Calendar
      mode="single"
      defaultMonth={new Date(2026, 8, 1)}
      disabled={[{ before: new Date(2026, 8, 10) }]}
    />,
  );
  const disabledDay = screen.getByRole("button", { name: /, 8 сентября 2026/ });
  expect(disabledDay).toBeDisabled();
  expect(disabledDay).not.toHaveClass("opacity-50");
  expect(disabledDay).toHaveClass("disabled:opacity-100", "disabled:text-muted-foreground");
  expect(disabledDay.parentElement).toHaveClass("text-muted-foreground");
  expect(disabledDay.parentElement).not.toHaveClass("opacity-50");
});

it("styles unavailable navigation through aria-disabled with an explicit color", () => {
  render(
    <Calendar
      mode="single"
      defaultMonth={new Date(2026, 8, 1)}
      startMonth={new Date(2026, 8, 1)}
    />,
  );
  const previous = screen.getByRole("button", { name: "Перейти к предыдущему месяцу" });
  expect(previous).toHaveAttribute("aria-disabled", "true");
  expect(previous).not.toHaveClass("opacity-50");
  expect(previous).toHaveClass("aria-disabled:text-[var(--text-disabled)]", "text-muted-foreground");
});

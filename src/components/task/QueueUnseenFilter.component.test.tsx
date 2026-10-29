import * as React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueueUnseenFilter } from "./QueueUnseenFilter";

afterEach(cleanup);

describe("QueueUnseenFilter", () => {
  it("renders visible label and accessible group with correct role and aria-label", () => {
    render(<QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} />);

    expect(screen.getByText("Просмотр")).toBeInTheDocument();

    const group = screen.getByRole("group", { name: "Фильтр просмотра" });
    expect(group).toBeInTheDocument();
    expect(group).toHaveClass("request-board-segment");

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent(/^Все$/);
    expect(buttons[1]).toHaveTextContent(/^Новые в очереди/);
  });

  it("reflects controlled aria-pressed state when unseenOnly is false", () => {
    render(<QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} />);

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    expect(allBtn).toHaveAttribute("aria-pressed", "true");
    expect(unseenBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("reflects controlled aria-pressed state when unseenOnly is true", () => {
    render(<QueueUnseenFilter unseenOnly={true} onChange={vi.fn()} />);

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    expect(allBtn).toHaveAttribute("aria-pressed", "false");
    expect(unseenBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("updates aria-pressed on controlled rerender without local state retention", () => {
    const { rerender } = render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} />
    );

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    expect(allBtn).toHaveAttribute("aria-pressed", "true");
    expect(unseenBtn).toHaveAttribute("aria-pressed", "false");

    rerender(<QueueUnseenFilter unseenOnly={true} onChange={vi.fn()} />);

    expect(allBtn).toHaveAttribute("aria-pressed", "false");
    expect(unseenBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChange with false when 'Все' is clicked", async () => {
    const handleChange = vi.fn();
    render(<QueueUnseenFilter unseenOnly={true} onChange={handleChange} />);

    const allBtn = screen.getByRole("button", { name: "Все" });
    fireEvent.click(allBtn);

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith(false);
  });

  it("calls onChange with true when 'Новые в очереди' is clicked", async () => {
    const handleChange = vi.fn();
    render(<QueueUnseenFilter unseenOnly={false} onChange={handleChange} />);

    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });
    fireEvent.click(unseenBtn);

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange even when clicking the already-selected option (controlled component)", () => {
    const handleChange = vi.fn();
    render(<QueueUnseenFilter unseenOnly={false} onChange={handleChange} />);

    const allBtn = screen.getByRole("button", { name: "Все" });
    fireEvent.click(allBtn);

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith(false);
  });

  it("ensures buttons have type='button' and do not submit enclosing form", () => {
    const handleSubmit = vi.fn((e) => e.preventDefault());
    const handleChange = vi.fn();

    render(
      <form onSubmit={handleSubmit}>
        <QueueUnseenFilter unseenOnly={false} onChange={handleChange} />
      </form>
    );

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    expect(allBtn).toHaveAttribute("type", "button");
    expect(unseenBtn).toHaveAttribute("type", "button");

    fireEvent.click(allBtn);
    expect(handleChange).toHaveBeenCalledWith(false);
    expect(handleSubmit).not.toHaveBeenCalled();

    fireEvent.click(unseenBtn);
    expect(handleChange).toHaveBeenCalledWith(true);
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("propagates disabled prop and prevents onChange invocation", () => {
    const handleChange = vi.fn();
    render(
      <QueueUnseenFilter
        unseenOnly={false}
        onChange={handleChange}
        disabled={true}
      />
    );

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    expect(allBtn).toBeDisabled();
    expect(unseenBtn).toBeDisabled();

    fireEvent.click(allBtn);
    fireEvent.click(unseenBtn);

    expect(handleChange).not.toHaveBeenCalled();
  });

  it("displays no count suffix when count prop is omitted/undefined", () => {
    render(<QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} />);

    const unseenBtn = screen.getByRole("button", { name: "Новые в очереди" });
    expect(unseenBtn).toHaveTextContent(/^Новые в очереди$/);
  });

  it("displays ' · 0' when count is 0", () => {
    render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={0} />
    );

    const unseenBtn = screen.getByRole("button", {
      name: "Новые в очереди · 0",
    });
    expect(unseenBtn).toHaveTextContent(/^Новые в очереди · 0$/);
  });

  it("displays ' · N' when count is a positive integer", () => {
    const { rerender } = render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={1} />
    );
    expect(
      screen.getByRole("button", { name: "Новые в очереди · 1" })
    ).toHaveTextContent(/^Новые в очереди · 1$/);

    rerender(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={15} />
    );
    expect(
      screen.getByRole("button", { name: "Новые в очереди · 15" })
    ).toHaveTextContent(/^Новые в очереди · 15$/);
  });

  it("does not display count number for negative integer count values", () => {
    render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={-1} />
    );

    const unseenBtn = screen.getByRole("button", { name: "Новые в очереди" });
    expect(unseenBtn).toHaveTextContent(/^Новые в очереди$/);
    expect(unseenBtn).not.toHaveTextContent("-1");
  });

  it("does not display count number for fractional count values", () => {
    render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={3.14} />
    );

    const unseenBtn = screen.getByRole("button", { name: "Новые в очереди" });
    expect(unseenBtn).toHaveTextContent(/^Новые в очереди$/);
    expect(unseenBtn).not.toHaveTextContent("3.14");
  });

  it("does not display count number for NaN or Infinity", () => {
    const { rerender } = render(
      <QueueUnseenFilter
        unseenOnly={false}
        onChange={vi.fn()}
        count={Number.NaN}
      />
    );
    expect(
      screen.getByRole("button", { name: "Новые в очереди" })
    ).toHaveTextContent(/^Новые в очереди$/);

    rerender(
      <QueueUnseenFilter
        unseenOnly={false}
        onChange={vi.fn()}
        count={Number.POSITIVE_INFINITY}
      />
    );
    expect(
      screen.getByRole("button", { name: "Новые в очереди" })
    ).toHaveTextContent(/^Новые в очереди$/);

    rerender(
      <QueueUnseenFilter
        unseenOnly={false}
        onChange={vi.fn()}
        count={Number.NEGATIVE_INFINITY}
      />
    );
    expect(
      screen.getByRole("button", { name: "Новые в очереди" })
    ).toHaveTextContent(/^Новые в очереди$/);
  });

  it("does not announce count changes as intrusive live alerts", () => {
    const { container, rerender } = render(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={0} />
    );

    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();

    rerender(
      <QueueUnseenFilter unseenOnly={false} onChange={vi.fn()} count={5} />
    );

    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("supports keyboard activation via Space and Enter keys", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<QueueUnseenFilter unseenOnly={true} onChange={handleChange} />);

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    allBtn.focus();
    expect(document.activeElement).toBe(allBtn);
    await user.keyboard("{Enter}");
    expect(handleChange).toHaveBeenCalledWith(false);

    unseenBtn.focus();
    expect(document.activeElement).toBe(unseenBtn);
    await user.keyboard(" ");
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it("does not trigger keyboard activation when disabled", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(
      <QueueUnseenFilter
        unseenOnly={false}
        onChange={handleChange}
        disabled={true}
      />
    );

    const allBtn = screen.getByRole("button", { name: "Все" });
    const unseenBtn = screen.getByRole("button", { name: /^Новые в очереди/ });

    allBtn.focus();
    await user.keyboard("{Enter}");
    unseenBtn.focus();
    await user.keyboard(" ");

    expect(handleChange).not.toHaveBeenCalled();
  });
});

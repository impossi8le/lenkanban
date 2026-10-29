import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskForm } from "./TaskForm";

afterEach(cleanup);

describe("uniform applicant form", () => {
  it.each(["board-receipts", "board-it"])("uses the same applicant fields on %s without workflow inputs", async projectId => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm projectId={projectId} defaultStatus="IN_PROGRESS" onSubmit={submit} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Статус")).not.toBeInTheDocument();
    expect(screen.queryByText("Приоритет")).not.toBeInTheDocument();
    expect(screen.queryByText("Дедлайн")).not.toBeInTheDocument();
    expect(screen.getByText("Вложения")).toBeInTheDocument();
    expect(screen.getByText(/В названии кратко укажите проблему/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "  Synthetic title  " } });
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "  Synthetic description  " } });
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith({ projectId, title: "Synthetic title", description: "Synthetic description" }));
  });

  it("does not require process values or description", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm projectId="board" onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Only title" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith({ projectId: "board", title: "Only title", description: "" }));
  });
});

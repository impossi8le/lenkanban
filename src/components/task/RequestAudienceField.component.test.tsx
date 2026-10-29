import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestAudienceField, type RequestAudienceChoice, type RequestRecipient } from "./RequestAudienceField";

afterEach(cleanup);

const recipients: RequestRecipient[] = [
  { id: "anna", name: "Анна Иванова" },
  { id: "boris", name: "Борис Петров" },
  { id: "vera", name: "Вера Сидорова" },
  { id: "gleb", name: "Глеб Волков" },
  { id: "dina", name: "Дина Орлова" },
];

function Fixture({ people = recipients, selected = [], disabled = false, loading = false, error = false, onRetry = vi.fn(), onSubmit = vi.fn() }: {
  people?: RequestRecipient[];
  selected?: string[];
  disabled?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState<RequestAudienceChoice>({ mode: "SELECTED", userIds: selected });
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <RequestAudienceField value={value} onChange={setValue} recipients={people} loading={loading} error={error} onRetry={onRetry} disabled={disabled} department="Техподдержка" />
    <output aria-label="Выбранные сотрудники">{value.userIds.join(",")}</output>
    <button type="submit">Отправить обращение</button>
  </form>;
}

describe("personal request recipient search", () => {
  it.each([1, 5, 8])("shows a labelled search for a small list of %i recipients", async count => {
    const user = userEvent.setup();
    const people = Array.from({ length: count }, (_, index) => ({ id: `user-${index}`, name: index === 0 ? "Анна Иванова" : `Сотрудник ${index}` }));
    render(<Fixture people={people} />);
    const search = screen.getByRole("searchbox", { name: "Найти сотрудника" });
    expect(search).toHaveAttribute("placeholder", "Введите имя или фамилию");
    await user.type(search, "  ИВАНОВА  ");
    expect(screen.getByRole("checkbox", { name: "Анна Иванова" })).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2); // Personal mode plus the matching recipient.
  });

  it("preserves a selected recipient while hidden by a filter and when selecting another", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("checkbox", { name: "Анна Иванова" }));
    const search = screen.getByRole("searchbox", { name: "Найти сотрудника" });
    await user.type(search, "Петров");
    expect(screen.queryByRole("checkbox", { name: "Анна Иванова" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Выбранные сотрудники")).toHaveTextContent("anna");
    await user.click(screen.getByRole("checkbox", { name: "Борис Петров" }));
    expect(screen.getByLabelText("Выбранные сотрудники")).toHaveTextContent("anna,boris");
    await user.clear(search);
    expect(screen.getByRole("checkbox", { name: "Анна Иванова" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Борис Петров" })).toBeChecked();
    expect(screen.getByText("Выбрано сотрудников: 2")).toBeVisible();
  });

  it("explains an empty search result and recovers all recipients when cleared", async () => {
    const user = userEvent.setup();
    render(<Fixture selected={["anna"]} />);
    const search = screen.getByRole("searchbox", { name: "Найти сотрудника" });
    await user.type(search, "Нет такого сотрудника");
    expect(screen.getByText("Сотрудник не найден. Измените поиск.")).toBeVisible();
    expect(screen.getByLabelText("Выбранные сотрудники")).toHaveTextContent("anna");
    await user.clear(search);
    expect(screen.queryByText("Сотрудник не найден. Измените поиск.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Анна Иванова" })).toBeChecked();
  });

  it("does not submit the surrounding request while searching, selecting or clearing selection", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Fixture onSubmit={onSubmit} />);
    await user.type(screen.getByRole("searchbox", { name: "Найти сотрудника" }), "Анна");
    await user.click(screen.getByRole("checkbox", { name: "Анна Иванова" }));
    expect(screen.getByRole("button", { name: "Снять выбор" })).toHaveAttribute("type", "button");
    await user.click(screen.getByRole("button", { name: "Снять выбор" }));
    expect(screen.getByLabelText("Выбранные сотрудники")).toBeEmptyDOMElement();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Отправить обращение" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps the twenty-person limit when searching and permits deselecting a selected person", async () => {
    const user = userEvent.setup();
    const people = Array.from({ length: 21 }, (_, index) => ({ id: `user-${index}`, name: `Сотрудник ${index}` }));
    render(<Fixture people={people} selected={people.slice(0, 20).map(person => person.id)} />);
    const search = screen.getByRole("searchbox", { name: "Найти сотрудника" });
    await user.type(search, "Сотрудник 20");
    expect(screen.getByRole("checkbox", { name: "Сотрудник 20" })).toBeDisabled();
    await user.clear(search);
    await user.type(search, "Сотрудник 0");
    expect(screen.getByRole("checkbox", { name: "Сотрудник 0" })).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "Сотрудник 0" }));
    await user.clear(search);
    await user.type(search, "Сотрудник 20");
    expect(screen.getByRole("checkbox", { name: "Сотрудник 20" })).toBeEnabled();
  });

  it("disables the search and recipients while the request field is disabled", () => {
    render(<Fixture disabled />);
    expect(screen.getByRole("searchbox", { name: "Найти сотрудника" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Анна Иванова" })).toBeDisabled();
  });

  it("keeps loading, retry and no-recipient states separate from an empty search result", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const view = render(<Fixture loading onRetry={onRetry} />);
    expect(screen.getByText("Загружаем сотрудников отдела…")).toBeVisible();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    view.rerender(<Fixture error onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось загрузить сотрудников");
    await user.click(screen.getByRole("button", { name: "Загрузить сотрудников ещё раз" }));
    expect(onRetry).toHaveBeenCalledOnce();
    view.rerender(<Fixture people={[]} />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByText(/В этом направлении пока нет доступных получателей/)).toBeVisible();
  });
});

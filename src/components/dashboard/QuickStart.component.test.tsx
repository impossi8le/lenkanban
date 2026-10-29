import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickStart, classifyDirectionName } from "./QuickStart";

vi.mock("@/components/task/CreateTaskDialog", () => ({
  CreateTaskDialog: (props: { projectId: string; projectName?: string; open: boolean }) =>
    props.open ? (
      <div
        data-testid="create-task-dialog"
        data-project-id={props.projectId}
        data-project-name={props.projectName}
      />
    ) : null,
}));

afterEach(cleanup);

describe("classifyDirectionName", () => {
  it.each([
    ["Техподдержка и ИТ", "support"],
    ["Обращения в ИТ", "support"],
    ["Helpdesk", "support"],
    ["Претензии клиентов", "claim"],
    ["Жалобы на мастеров", "claim"],
    ["Возвраты и рекламации", "claim"],
    ["Кредитный отдел", null],
    ["Безнал ОП", "beznal"],
  ])("classifies %s as %s", (name, expected) => {
    expect(classifyDirectionName(name)).toBe(expected);
  });
});

describe("QuickStart", () => {
  const support = { projectId: "board-it", projectName: "Техподдержка и ИТ" };
  const claim = { projectId: "board-claims", projectName: "Претензии клиентов" };

  it("renders the two approved destinations with their hints", () => {
    render(<QuickStart directions={{ support, claim }} canSetupDirections={false} />);

    expect(screen.getByRole("button", { name: /Написать в Техподдержку/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Передать недовольного клиента/ })).toBeInTheDocument();
    expect(screen.getByText("Сбой программы, телефонии, компьютера, доступы")).toBeInTheDocument();
    expect(screen.getByText("Жалоба на мастера, возврат, срочный звонок ОЗОК")).toBeInTheDocument();
  });

  it("opens the real create dialog with the authorized board of the chosen direction", async () => {
    render(<QuickStart directions={{ support, claim }} canSetupDirections={false} />);

    expect(screen.queryByTestId("create-task-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Передать недовольного клиента/ }));

    const dialog = await screen.findByTestId("create-task-dialog");
    expect(dialog).toHaveAttribute("data-project-id", "board-claims");
    expect(dialog).toHaveAttribute("data-project-name", "Претензии клиентов");
  });

  it("shows an admin setup link only when a direction is missing and the user may set it up", () => {
    const { unmount } = render(<QuickStart directions={{ support }} canSetupDirections />);
    expect(screen.getAllByRole("link", { name: /Настроить направления/ })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /Настроить направления/ })[0]).toHaveAttribute("href", "/projects");
    expect(screen.queryByRole("button", { name: /Передать недовольного клиента/ })).not.toBeInTheDocument();
    unmount();

    render(<QuickStart directions={{ support }} canSetupDirections={false} />);
    expect(screen.queryByRole("link", { name: /Настроить направления/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Обратитесь к администратору/)).toHaveLength(2);
  });
});

it("opens the authorized Безнал ОП board from the chooser",async()=>{
 render(<QuickStart directions={{beznal:{projectId:"real-beznal",projectName:"Безнал ОП"}}} canSetupDirections={false}/>);
 fireEvent.click(screen.getByRole("button",{name:/Обращение в Безнал ОП/}));
 expect(await screen.findByTestId("create-task-dialog")).toHaveAttribute("data-project-id","real-beznal");
});

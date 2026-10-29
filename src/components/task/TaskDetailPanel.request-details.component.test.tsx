import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "./../kanban/Card";
import { decodeRequestDescription, encodeRequestDescription } from "@/lib/request-presentation";
import { TaskDetailPanel } from "./TaskDetailPanel";

vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: () => null }));

vi.mock("next/dynamic", () => ({ default: (loader: () => unknown) => function DynamicStub(props: { content: string; onChange: (value: string) => void; onSave: () => void }) {
  return loader.toString().includes("RichTextEditor") ? <><textarea aria-label="Текст описания" value={props.content} onChange={event => props.onChange(event.target.value)}/><button onClick={props.onSave}>Сохранить описание</button></> : null;
} }));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskRequestLifecycleControls", () => ({ TaskRequestLifecycleControls: ({ actorId }: { actorId?: string }) => <section aria-label="Действия заявки" data-actor-id={actorId}><button>Завершить</button></section> }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "claim-author" } } }) }));

const details = { kind: "claim" as const, category: "Качество", order: "5305316", phone: "+7 000 000-00-00", client: "Синтетический клиент", want: "Повторный выезд" };
const task: TaskType = { id: "structured-claim", projectId: "claims", title: "Претензия", description: encodeRequestDescription("<p>Исходный текст</p>", details), priority: "LOW", position: 0, version: 7, assignees: [], tags: [] };
beforeEach(() => {
  vi.useFakeTimers();
  const frame = document.createElement("iframe");document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);localStorage.clear();
});
afterEach(() => { cleanup();vi.useRealTimers();vi.unstubAllGlobals();document.querySelectorAll("iframe").forEach(frame => frame.remove()); });

describe("structured request editor boundary", () => {
  it("places executor actions before a long description and binds them to the active account", () => {
    render(<TaskDetailPanel task={{ ...task, description: "Длинное описание. ".repeat(1000) }} onClose={vi.fn()} onSave={vi.fn()} />);
    const actions = screen.getByRole("region", { name: "Действия заявки" });
    const description = screen.getByRole("textbox", { name: "Текст описания" });
    expect(actions.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions).toHaveAttribute("data-actor-id", "claim-author");
  });
  it("shows only body and saves edited HTML with the original order/phone metadata", async () => {
    const onSave=vi.fn();
    render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={onSave}/>);
    const editor=screen.getByRole("textbox", { name: "Текст описания" });
    expect(editor).toHaveValue("<p>Исходный текст</p>");
    expect((editor as HTMLTextAreaElement).value).not.toContain("Сведения об обращении");
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(editor,{target:{value:"<p>Уточнённое <strong>описание</strong></p>"}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Сохранить описание"}));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [id,payload,callbacks]=onSave.mock.calls[0];
    expect(id).toBe(task.id);
    expect(decodeRequestDescription(payload.description)).toEqual({details,body:"<p>Уточнённое <strong>описание</strong></p>"});
    expect(callbacks).toEqual({onSuccess:expect.any(Function),onError:expect.any(Function)});
    expect(editor).toHaveValue("<p>Уточнённое <strong>описание</strong></p>");
  });

  it("keeps metadata through an early edit and same-task server update", async () => {
    const onSave=vi.fn(),props={onClose:vi.fn(),onSave};
    const view=render(<TaskDetailPanel task={task} {...props}/>);
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox",{name:"Текст описания"}),{target:{value:"<p>Локальное уточнение</p>"}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(50);});
    view.rerender(<TaskDetailPanel task={{...task,description:encodeRequestDescription("<p>Серверное обновление</p>",details)}} {...props}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
    expect(screen.getByRole("textbox",{name:"Текст описания"})).toHaveValue("<p>Локальное уточнение</p>");
    fireEvent.click(screen.getByRole("button",{name:"Сохранить описание"}));
    expect(decodeRequestDescription(onSave.mock.calls[0][1].description)).toEqual({details,body:"<p>Локальное уточнение</p>"});
  });
});

it("displays and preserves every Безнал ОП field while editing the common description",async()=>{
 const bank={kind:"beznal" as const,category:"Разобраться с платежом",bankKind:"payment" as const,company:"ТЕСТ ООО",amount:"125 000",paymentDate:"2026-10-28",invoiceNumber:"184-А",orderNumber:"заказ-572",paymentPurpose:"Оплата\nПо договору 17"};
 const onSave=vi.fn();
 render(<TaskDetailPanel task={{...task,id:"bank-task",description:encodeRequestDescription("Описание платежа",bank)}} onClose={vi.fn()} onSave={onSave}/>);
 expect(screen.getByText("28.10.2026")).toBeInTheDocument();
 expect(screen.getByText("ТЕСТ ООО")).toBeInTheDocument();expect(screen.getByText("184-А")).toBeInTheDocument();expect(screen.getByText("заказ-572")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Изменить описание"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Текст описания"}),{target:{value:"Уточнение"}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1100);});
 fireEvent.click(screen.getByRole("button",{name:"Сохранить описание"}));
 expect(decodeRequestDescription(onSave.mock.calls[0][1].description)).toEqual({details:bank,body:"Уточнение"});
});

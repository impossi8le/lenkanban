import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestActionsContext } from '@/components/task/RequestQuickTake';
import { uploadTaskAttachments } from '@/components/task/TaskFormAttachments';
import { beznalDescriptionText } from './BeznalDemoDescription';
import { RequestBoardPresentation } from './RequestBoardPresentation';
import { encodeRequestDescription } from '@/lib/request-presentation';
import type { TaskType } from './Card';

const sessionMock=vi.hoisted(()=>({actorId:'author'}));
vi.mock('next-auth/react',()=>({useSession:()=>({data:{user:{id:sessionMock.actorId}}})}));
vi.mock('./Card', () => ({ KanbanCardView: ({ task, onOpen }: { task: TaskType; onOpen: () => void }) => <button onClick={onOpen}>{task.title}</button> }));
vi.mock('@/components/task/TaskFormAttachments', () => ({ ATTACHMENT_ACCEPT: '.pdf', uploadTaskAttachments: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionMock.actorId="author"; });

it('filters personal unseen arrivals in both views without treating every submitted request as unseen', () => {
  const fresh = { ...task('Поступила сейчас', 'SUBMITTED'), queueArrival: { epoch: 2, unseen: true } };
  const read = { ...task('Уже просмотрена', 'SUBMITTED'), queueArrival: { epoch: 2, unseen: false } };
  const legacy = task('Существовала до запуска', 'SUBMITTED');
  const view = render(<RequestBoardPresentation tasks={[fresh, read, legacy]} defaultView="list" onOpen={vi.fn()} />);
  expect(screen.getByText('● Новое для вас')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Новые в очереди · 1' }));
  expect(screen.getByRole('button', { name: 'Открыть обращение «Поступила сейчас»' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Открыть обращение «Уже просмотрена»' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Открыть обращение «Существовала до запуска»' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Доска' }));
  expect(screen.getByRole('button', { name: 'Поступила сейчас' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Уже просмотрена' })).not.toBeInTheDocument();
  view.rerender(<RequestBoardPresentation tasks={[{ ...fresh, queueArrival: { epoch: 2, unseen: false } }, read, legacy]} defaultView="list" onOpen={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Поступила сейчас' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Новые в очереди · 0' })).toHaveAttribute('aria-pressed', 'true');
});

it('keeps view and entered filters across a failed read while hiding request rows', () => {
  const row = task('Нужная заявка', 'SUBMITTED');
  const retry = vi.fn();
  const view = render(<RequestBoardPresentation tasks={[row]} onOpen={vi.fn()} onRetryRead={retry} />);
  fireEvent.click(screen.getByRole('button', { name: 'Список' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: 'Нужная' } });
  view.rerender(<RequestBoardPresentation tasks={[]} readError onOpen={vi.fn()} onRetryRead={retry} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось загрузить задачи');
  expect(screen.queryByRole('region', { name: 'Список обращений' })).not.toBeInTheDocument();
  expect(screen.queryByText('Нужная заявка')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<RequestBoardPresentation tasks={[row]} onOpen={vi.fn()} onRetryRead={retry} />);
  expect(screen.getByRole('button', { name: 'Список' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('textbox', { name: 'Поиск обращений' })).toHaveValue('Нужная');
  expect(screen.getByRole('button', { name: 'Открыть обращение «Нужная заявка»' })).toBeVisible();
});

it.each(['Название уникальное','Описание уникальное','Автор уникальный','Исполнитель уникальный'])('finds an accessible canonical request by %s in both views', query => {
  const row:TaskType={id:'canonical',projectId:'board',position:0,priority:'LOW',title:'Название уникальное',description:'Описание уникальное',createdBy:{id:'old-author',name:'Старый автор'},
    request:{state:'IN_PROGRESS',executorId:'current',isPersonal:true,author:{id:'author',name:'Автор уникальный'},executor:{id:'current',name:'Исполнитель уникальный'}},
    assignees:[{id:'stale',user:{id:'old',name:'Прежний исполнитель',email:'old@example.invalid'}}]};
  render(<RequestBoardPresentation tasks={[row]} defaultView="list" onOpen={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Поиск обращений'}),{target:{value:query}});
  expect(screen.getByRole('button',{name:'Открыть обращение «Название уникальное»'})).toBeVisible();
  expect(screen.getByText('Персональная заявка')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Доска'}));
  expect(screen.getByRole('button',{name:'Название уникальное'})).toBeVisible();
  fireEvent.change(screen.getByRole('textbox',{name:'Поиск обращений'}),{target:{value:'Прежний исполнитель'}});
  expect(screen.queryByRole('button',{name:'Название уникальное'})).toBeNull();
});
const task = (id: string, state: string, priority = 'LOW'): TaskType => ({ id, projectId: 'claims', title: id, priority, position: 0, request: { state, executorId: null, author: { id: 'author', name: 'Мария' } }, createdBy: { id: 'author', name: 'Мария', primaryDepartment: { name: 'Колл-центр' } } });

describe('approved demo board interactions', () => {
  it('searches claim order, phone and author while combining category and two-level urgency', () => {
    const claim = { ...task('Претензия', 'SUBMITTED', 'HIGH'), description: encodeRequestDescription('Холодильник не охлаждает', { kind: 'claim', category: 'Качество', order: '5305316', phone: '+7 000 1234567', client: 'Клиент', want: 'Повторный выезд' }) };
    render(<RequestBoardPresentation tasks={[claim, task('Другая', 'IN_PROGRESS')]} claim onOpen={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: '5305316' } });
    expect(screen.getByRole('button', { name: 'Претензия' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Другая' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Срочно' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Категория' }), { target: { value: 'Качество' } });
    expect(screen.getByRole('button', { name: 'Претензия' })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: '000 1234567' } });
    expect(screen.getByRole('button', { name: 'Претензия' })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: 'Мария' } });
    expect(screen.getByRole('button', { name: 'Претензия' })).toBeVisible();
  });
});

it('defaults to an accessible list when requested and opens through the existing focus-aware callback', () => {
  const onOpen = vi.fn(); const titleButtonRef = vi.fn();
  const row = { ...task('Починить гарнитуру', 'IN_PROGRESS'), request: {state:'IN_PROGRESS',executorId:'executor'}, assignees: [{ id: 'assignment', user: { id: 'executor', name: 'Алексей', email: 'staff@example.test' } }], createdAt: '2026-10-27T09:00:00Z', updatedAt: '2026-10-27T10:00:00Z' };
  render(<RequestBoardPresentation tasks={[row]} defaultView="list" onOpen={onOpen} titleButtonRef={titleButtonRef} />);
  expect(screen.getByRole('region', { name: 'Список обращений' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Колонки обращений' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Список обращений' })).getByText('В работе')).toBeVisible();
  expect(screen.getByText('Автор: Мария')).toBeVisible();
  expect(screen.getByText('Исполнитель: Алексей')).toBeVisible();
  expect(screen.getByLabelText('Последнее обновление, московское время')).toHaveTextContent('Обновлено:');
  const button = screen.getByRole('button', { name: 'Открыть обращение «Починить гарнитуру»' });
  expect(titleButtonRef).toHaveBeenCalledWith(row.id, button);
  fireEvent.click(button); expect(onOpen).toHaveBeenCalledExactlyOnceWith(row, button);
});

it('preserves filters when opening and switching views, and provides an explicit reset', () => {
  const onOpen = vi.fn();
  const urgent = { ...task('Срочная помощь', 'SUBMITTED', 'HIGH'), description: encodeRequestDescription('Проблема со звуком', { kind: 'it', category: 'Звук' }) };
  const rows = [urgent, task('Другая', 'SUBMITTED')];
  const view = render(<RequestBoardPresentation tasks={rows} defaultView="list" onOpen={onOpen} />);
  expect(within(screen.getByRole("region", { name: "Список обращений" })).getByText("Срочно")).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: 'помощь' } });
  fireEvent.click(screen.getByRole('button', { name: 'Срочные' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Категория' }), { target: { value: 'Звук' } });
  fireEvent.click(screen.getByRole('button', { name: 'Открыть обращение «Срочная помощь»' }));
  view.rerender(<RequestBoardPresentation tasks={[...rows]} defaultView="list" onOpen={onOpen} />);
  expect(screen.getByRole('textbox', { name: 'Поиск обращений' })).toHaveValue('помощь');
  fireEvent.click(screen.getByRole('button', { name: 'Доска' }));
  expect(screen.getByRole('button', { name: 'Срочная помощь' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Другая' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Список' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
  expect(screen.getByRole('textbox', { name: 'Поиск обращений' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Категория' })).toHaveValue('');
  expect(within(screen.getByRole('group', { name: 'Фильтр срочности' })).getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(screen.getByRole('group', { name: 'Фильтр просмотра' })).getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Открыть обращение «Другая»' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Сбросить фильтры' })).toBeDisabled();
});

it('explains an empty filtered list and resets the archive as well', () => {
  render(<RequestBoardPresentation tasks={[task('Новая', 'SUBMITTED'), task('Закрытая', 'CLOSED')]} defaultView="list" onOpen={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Показать' }), { target: { value: 'closed' } });
  expect(screen.getByRole('button', { name: 'Открыть обращение «Закрытая»' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск обращений' }), { target: { value: 'не существует' } });
  expect(screen.getByText(/По выбранным фильтрам обращений нет/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
  expect(screen.getByRole('button', { name: 'Открыть обращение «Новая»' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Открыть обращение «Закрытая»' })).not.toBeInTheDocument();
});


it('orders urgent first then newest creation in the list and every column, without changing the input', () => {
  const row = (id: string, priority: string, createdAt: string, updatedAt = createdAt) => ({...task(id, 'SUBMITTED', priority), createdAt, updatedAt});
  const rows = [row('обычная новая', 'LOW', '2026-10-27T10:00:00Z'), row('срочная старая', 'CRITICAL', '2026-10-20T10:00:00Z'),
    row('срочная новая a', 'HIGH', '2026-10-26T10:00:00Z'), row('обычная старая', 'MEDIUM', '2026-10-19T10:00:00Z', '2026-10-28T10:00:00Z'),
    row('срочная новая z', 'URGENT', '2026-10-26T10:00:00Z')];
  const original = rows.map(row=>row.id);
  render(<RequestBoardPresentation tasks={rows} defaultView="list" onOpen={vi.fn()}/>);
  const expected = ['срочная новая z', 'срочная новая a', 'срочная старая', 'обычная новая', 'обычная старая'];
  expect(within(screen.getByRole('region', {name:'Список обращений'})).getAllByRole('button').map(button=>button.textContent)).toEqual(expected);
  fireEvent.click(screen.getByRole('button',{name:'Доска'}));
  expect(within(screen.getByRole('region', {name:'Колонки обращений'})).getAllByRole('button').map(button=>button.textContent)).toEqual(expected);
  expect(rows.map(row=>row.id)).toEqual(original);
});



it.each([false,true])("uses one list status filter, never shows drafts, and preserves original objects (claim=%s)", claim => {
 const rows=[task("Новое письмо","SUBMITTED"),task("Рабочее письмо","IN_PROGRESS"),task("Уточнение письма","NEEDS_INFO"),task("Решённое письмо","COMPLETED"),task("Закрытое письмо","CLOSED"),task("Отменённое письмо","CANCELLED"),task("Черновое письмо","DRAFT")];
 const original=JSON.stringify(rows),onOpen=vi.fn();
 render(<RequestBoardPresentation tasks={rows} claim={claim} defaultView="list" onOpen={onOpen}/>);
 const filter=screen.getByRole("combobox",{name:"Показать"});
 expect(filter).toHaveValue("open"); expect(filter).toHaveClass("min-h-12");
 expect(within(filter).getAllByRole("option").map(x=>x.textContent)).toEqual(["Все открытые",claim?"Ждёт сотрудника":"Новые","В работе","Закрытые — архив","Все, включая закрытые"]);
 expect(screen.queryByRole("group",{name:"Раздел обращений"})).not.toBeInTheDocument();
 const cases=[ ["open",[0,1,2]], ["new",[0]], ["work",[1,2]], ["closed",[3,4,5]], ["all",[0,1,2,3,4,5]] ] as const;
 for(const [value,expected] of cases){
  fireEvent.change(filter,{target:{value}});
  rows.forEach((row,index)=>expect(Boolean(screen.queryByRole("button",{name:`Открыть обращение «${row.title}»`}))).toBe(([...expected] as number[]).includes(index)));
 }
 fireEvent.click(screen.getByRole("button",{name:"Открыть обращение «Уточнение письма»"}));
 expect(onOpen.mock.calls[0][0]).toBe(rows[2]);
 expect(screen.getByText('Решено · Работа выполнена', { exact: true })).toBeVisible();
 expect(screen.queryByText(/ждёт подтверждения автора/)).not.toBeInTheDocument();
 expect(screen.getByText(/Помощь отменена/)).toBeVisible();
  const cancelled = screen.getByRole("button", { name: "Открыть обращение «Отменённое письмо»" }).closest("article")!;
  expect(within(cancelled).queryByText("Ждёт специалиста")).not.toBeInTheDocument();
  expect(within(cancelled).getByText("Исполнитель не указан")).toBeVisible();
 fireEvent.change(screen.getByRole("textbox",{name:"Поиск обращений"}),{target:{value:"несуществующее"}});
 expect(screen.getByText(/По выбранным фильтрам обращений нет/)).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:"Сбросить фильтры"}));
 expect(filter).toHaveValue("open"); expect(screen.getByRole("textbox",{name:"Поиск обращений"})).toHaveValue("");
 expect(screen.queryByRole("button",{name:/Черновики/})).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Открыть обращение «Решённое письмо»"})).not.toBeInTheDocument();
 expect(JSON.stringify(rows)).toBe(original);
});

it.each([false,true])("shows only open board columns and an explicit closed archive, syncing the list (claim=%s)",claim=>{
 const rows=[task("Новая","SUBMITTED"),task("Рабочая","IN_PROGRESS"),task("Уточнение","NEEDS_INFO"),task("Решённая","COMPLETED"),task("Закрытая","CLOSED"),task("Отменённая","CANCELLED"),task("Черновая","DRAFT")];
 const onOpen=vi.fn();render(<RequestBoardPresentation tasks={rows} claim={claim} onOpen={onOpen}/>);
 const board=screen.getByRole("region",{name:"Колонки обращений"});
 expect(within(board).getAllByRole("heading")).toHaveLength(claim?2:3);
 expect(within(board).getByRole("region",{name:claim?"Ждёт сотрудника":"Новые"})).toContainElement(screen.getByRole("button",{name:"Новая"}));
 if(claim)expect(screen.getByText("Обращение ещё никто не взял в работу")).toBeVisible();
 expect(screen.queryByRole("button",{name:"Решённая"})).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Черновая"})).not.toBeInTheDocument();
 expect(within(board).getByRole("region",{name:claim?"В работе":"Ждём сотрудника"})).toContainElement(screen.getByRole("button",{name:"Уточнение"}));
 fireEvent.click(screen.getByRole("button",{name:"Архив · 3"}));
 expect(screen.getByRole("button",{name:"Архив · 3"})).toHaveAttribute("aria-pressed","true");
 for(const name of ["Решённая","Закрытая","Отменённая"])expect(screen.getByRole("button",{name})).toBeVisible();
 expect(within(board).getAllByRole("heading").map(x=>x.textContent)).toEqual(["Решено1","Закрыто2"]);
 expect(screen.getByText(/Карточки, переписка и файлы доступны/)).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:"Решённая"}));expect(onOpen.mock.calls[0][0]).toBe(rows[3]);expect(rows[3].request?.state).toBe("COMPLETED");
 fireEvent.click(screen.getByRole("button",{name:"Список"}));expect(screen.getByRole("combobox",{name:"Показать"})).toHaveValue("closed");
 fireEvent.change(screen.getByRole("combobox",{name:"Показать"}),{target:{value:"all"}});
 expect(screen.queryByRole("button",{name:"Открыть обращение «Черновая»"})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Доска"}));expect(screen.getByRole("button",{name:"Текущие обращения"})).toHaveAttribute("aria-pressed","true");
 expect(screen.queryByRole("button",{name:"Решённая"})).not.toBeInTheDocument();
});

it('groups Безнал ОП by saved attachments with closed outcomes only in archive and real onOpen',()=>{
 const rows=[task('Запрос счёта','SUBMITTED'),{...task('Проверка','IN_PROGRESS'),attachments:[{url:'/file.pdf',name:'Счёт.pdf',mime:'application/pdf',size:12}]},task('Уточнить платёж','NEEDS_INFO'),task('Разнесено','COMPLETED'),task('Подтверждено','CLOSED'),task('Отменён платёж','CANCELLED')];
 const original=JSON.stringify(rows),onOpen=vi.fn();
 render(<RequestBoardPresentation tasks={rows} beznal onOpen={onOpen}/>);
 const board=screen.getByRole('region',{name:'Колонки обращений'});
 expect(within(board).getAllByRole('heading').map(node=>node.textContent)).toEqual(['Ждут обработки2','Со счётом1']);
 expect(within(board).getByRole('region',{name:'Ждут обработки'})).toContainElement(screen.getByRole('button',{name:'Открыть обращение «Уточнить платёж»'}));
 expect(within(board).getByRole('region',{name:'Со счётом'})).toContainElement(screen.getByRole('button',{name:'Открыть обращение «Проверка»'}));
 expect(screen.queryByRole('button',{name:'Открыть обращение «Разнесено»'})).toBeNull();
 expect(within(screen.getByLabelText('Сводка обращений')).getAllByRole('strong').map(node=>node.textContent)).toEqual(['3','2','1']);
 const opener=screen.getByRole('button',{name:'Открыть обращение «Проверка»'});
 fireEvent.click(opener);expect(onOpen).toHaveBeenCalledWith(rows[1],opener);
 expect(JSON.stringify(rows)).toBe(original);
 fireEvent.click(screen.getByRole('button',{name:'Архив · 3'}));
 expect(within(board).getAllByRole('heading').map(node=>node.textContent)).toEqual(['Закрыто3']);
 expect(screen.getByText('Работа выполнена',{exact:true})).toBeVisible();
 expect(screen.getByRole('button',{name:'Открыть обращение «Разнесено»'})).toBeVisible();
});

it('keeps phase unchanged on cancel/error and waits for persisted attachments after success',async()=>{
 const row={...task('Счёт для клиента','SUBMITTED'),request:{state:'SUBMITTED',executorId:null,author:{id:'author',name:'Автор'}}};
 const view=(rows:TaskType[]) => <RequestActionsContext.Provider value={true}><RequestBoardPresentation tasks={rows} beznal onOpen={vi.fn()}/></RequestActionsContext.Provider>;
 const {rerender}=render(view([row]));
 const input=screen.getByLabelText('Файл счёта для «Счёт для клиента»');
 const pending=()=>within(screen.getByRole('region',{name:'Ждут обработки'})).getByRole('button',{name:'Открыть обращение «Счёт для клиента»'});
 fireEvent.change(input,{target:{files:[]}});expect(uploadTaskAttachments).not.toHaveBeenCalled();expect(pending()).toBeVisible();
 vi.mocked(uploadTaskAttachments).mockRejectedValueOnce(new Error('failed'));
 fireEvent.change(input,{target:{files:[new File(['invoice'],'invoice.pdf',{type:'application/pdf'})]}});
 await waitFor(()=>expect(screen.getByRole('alert')).toBeVisible());expect(pending()).toBeVisible();
 act(()=>window.dispatchEvent(new CustomEvent('beznal:attachment-committed',{detail:{taskId:'foreign'}})));
 expect(screen.queryByText(/Обновляем данные/)).toBeNull();
 vi.mocked(uploadTaskAttachments).mockResolvedValueOnce([{url:'/invoice.pdf',name:'invoice.pdf',mime:'application/pdf',size:7}]);
 fireEvent.change(input,{target:{files:[new File(['invoice'],'invoice.pdf',{type:'application/pdf'})]}});
 await waitFor(()=>expect(screen.getByText(/Обновляем данные обращения/)).toBeVisible());
 expect(pending()).toBeVisible();expect(document.querySelector('[data-beznal-highlighted]')).toBeNull();
 const saved={...row,attachments:[{url:'/invoice.pdf',name:'invoice.pdf',mime:'application/pdf',size:7}]};
 rerender(view([saved,saved]));
 expect(within(screen.getByRole('region',{name:'Со счётом'})).getByRole('button',{name:'Открыть обращение «Счёт для клиента»'})).toBeVisible();
 expect(document.querySelectorAll('[data-beznal-highlighted]')).toHaveLength(1);
 rerender(view([{...saved,version:2}]));expect(document.querySelectorAll('[data-beznal-highlighted]')).toHaveLength(1);
});

it.each(['other-executor'])('opens the ordinary card before a non-author attaches when executor is %s',executorId=>{
 sessionMock.actorId='accountant';
 const row={...task('Ожидающий счёт','SUBMITTED'),request:{state:'SUBMITTED',executorId,author:{id:'author',name:'Автор'}}};
 const onOpen=vi.fn();
 render(<RequestActionsContext.Provider value={true}><RequestBoardPresentation tasks={[row]} beznal onOpen={onOpen}/></RequestActionsContext.Provider>);
 expect(screen.queryByLabelText('Файл счёта для «Ожидающий счёт»')).toBeNull();
 expect(screen.getByText(/сначала возьмите его на себя/)).toBeVisible();
 const opener=screen.getByRole('button',{name:'Прикрепить файл'});
 fireEvent.click(opener);expect(onOpen).toHaveBeenCalledExactlyOnceWith(row,opener);
 expect(uploadTaskAttachments).not.toHaveBeenCalled();
});

it('lets an eligible accountant choose a file directly for a free request without claiming on cancel',()=>{
 sessionMock.actorId='accountant';
 const row={...task('Свободная заявка','SUBMITTED'),request:{state:'SUBMITTED',executorId:null,author:{id:'author',name:'Автор'}}};
 const onOpen=vi.fn();
 render(<RequestActionsContext.Provider value={true}><RequestBoardPresentation tasks={[row]} beznal onOpen={onOpen}/></RequestActionsContext.Provider>);
 const input=screen.getByLabelText('Файл счёта для «Свободная заявка»');
 fireEvent.change(input,{target:{files:[]}});
 expect(uploadTaskAttachments).not.toHaveBeenCalled();expect(onOpen).not.toHaveBeenCalled();
 expect(screen.getByText('Не назначен')).toBeVisible();
});

it('keeps quick upload for the sales author but hides it for foreign common requests',()=>{
 const mine={...task('Моя заявка','SUBMITTED'),request:{state:'SUBMITTED',executorId:null,author:{id:'author',name:'Автор'}}};
 const foreign={...task('Чужая заявка','SUBMITTED'),request:{state:'SUBMITTED',executorId:null,author:{id:'other',name:'Коллега'}}};
 render(<RequestActionsContext.Provider value={false}><RequestBoardPresentation tasks={[mine,foreign]} beznal onOpen={vi.fn()}/></RequestActionsContext.Provider>);
 expect(screen.getByLabelText('Файл счёта для «Моя заявка»')).toBeInTheDocument();
 expect(screen.queryByLabelText('Файл счёта для «Чужая заявка»')).not.toBeInTheDocument();
 expect(screen.getAllByRole('button',{name:'Прикрепить файл'})).toHaveLength(1);
});

it('keeps returned invoices waiting with old files and orders by visible work regardless of urgency',()=>{
 const old={...task('Старая срочная','IN_PROGRESS','HIGH'),createdAt:'2026-10-28T10:00:00Z',lastVisibleWorkAt:'2026-10-28T10:00:00Z',updatedAt:'2026-10-28T23:59:59Z',request:{state:'IN_PROGRESS',executorId:'accountant',beznalPhase:'WAITING' as const},attachments:[{url:'/old.pdf',name:'old.pdf',mime:'application/pdf',size:1}]};
 const recent={...task('Новое действие','IN_PROGRESS'),createdAt:'2026-10-28T09:00:00Z',lastVisibleWorkAt:'2026-10-28T11:00:00Z',request:{state:'IN_PROGRESS',executorId:'accountant',beznalPhase:'WAITING' as const}};
 render(<RequestBoardPresentation tasks={[old,recent]} beznal onOpen={vi.fn()}/>);
 const waiting=screen.getByRole('region',{name:'Ждут обработки'});
 expect(within(waiting).getAllByRole('button',{name:/Открыть обращение/}).map(button=>button.textContent)).toEqual(['Новое действие','Старая срочная']);
 expect(within(screen.getByRole('region',{name:'Со счётом'})).queryByRole('button',{name:/Открыть обращение/})).toBeNull();
});

it('renders and copies only text from description HTML',()=>{
 expect(beznalDescriptionText('<p>Счёт &amp; заказ</p><script>alert(1)</script><img src=x onerror=alert(1)>')).toBe('Счёт & заказ');
});

it('finds bank metadata in the existing board search including optional payment date',()=>{
 const row={...task('Проверить поступление','IN_PROGRESS'),description:encodeRequestDescription('',{kind:'beznal',category:'Безнал ОП',company:'ТЕСТ ООО',amount:'125 000',paymentDate:'2026-10-28',invoiceNumber:'184-А',orderNumber:'заказ-572',paymentPurpose:'Договор 17'})};
 render(<RequestBoardPresentation tasks={[row]} beznal onOpen={vi.fn()}/>);
 for(const term of ['ТЕСТ ООО','125 000','2026-10-28','184-А','заказ-572','Договор 17']){
  fireEvent.change(screen.getByRole('textbox',{name:'Поиск обращений'}),{target:{value:term}});
  expect(screen.getByRole('button',{name:'Открыть обращение «Проверить поступление»'})).toBeVisible();
 }
});

it('puts a genuine update first with live relative age and creation above the title on the left',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-28T14:47:00Z'));
 try {
 const row={...task('Даты счёта','SUBMITTED'),createdAt:'2026-10-28T14:10:00.000Z',updatedAt:'2026-10-28T14:11:00.000Z'};
 const {rerender}=render(<RequestBoardPresentation tasks={[row]} beznal onOpen={vi.fn()}/>);
 const update=screen.getByLabelText('Последнее обновление, московское время'),creation=screen.getByLabelText('Создание обращения, московское время');
 const title=screen.getByRole('button',{name:'Открыть обращение «Даты счёта»'}),card=title.closest('article')!;
 expect(card.firstElementChild).toBe(update);
 expect(update).toHaveTextContent('Обновлено: 28.10.2026, 17:11');
 expect(within(update).getByText('28.10.2026, 17:11')).toHaveAttribute('datetime',row.updatedAt);
 expect(within(update).getByText('36 мин назад')).toHaveAttribute('datetime',row.updatedAt);
 act(()=>vi.advanceTimersByTime(60000));expect(within(update).getByText('37 мин назад')).toBeVisible();
 expect(creation).toHaveClass('text-left');expect(creation).toHaveTextContent('Создано: 28.10.2026, 17:10');
 expect(creation.compareDocumentPosition(title)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(within(creation).getByText('28.10.2026, 17:10')).toHaveAttribute('datetime',row.createdAt);
 rerender(<RequestBoardPresentation tasks={[{...row,updatedAt:'2026-10-28T14:48:00Z'}]} beznal onOpen={vi.fn()}/>);
 expect(update).toHaveTextContent('Обновлено: 28.10.2026, 17:48');expect(creation).toHaveTextContent('17:10');
 } finally {cleanup();vi.useRealTimers();}
});
it.each([
 ['2026-10-28T14:10:00Z','2026-10-28T14:10:00Z'],
 ['2026-10-28T14:10:00Z','2026-10-28T14:09:00Z'],
 ['invalid','2026-10-28T14:11:00Z'],
 [undefined,'2026-10-28T14:11:00Z'],
 ['2026-10-28T14:10:00Z',undefined],
 ['2026-10-28T14:10:00Z','invalid'],
])('hides unproven update row for creation=%s update=%s',(createdAt,updatedAt)=>{
 render(<RequestBoardPresentation tasks={[{...task('Без изменений','SUBMITTED'),createdAt,updatedAt}]} beznal onOpen={vi.fn()}/>);
 expect(screen.queryByLabelText('Последнее обновление, московское время')).toBeNull();
 const creation=screen.getByLabelText('Создание обращения, московское время');
 expect(creation).not.toHaveTextContent('Invalid Date');
 if(!createdAt||createdAt==='invalid'){expect(creation).toHaveTextContent('Создано: не указано');expect(creation.querySelector('time')).toBeNull();}
});

it('opens on blank card click and title once while preserving description/upload interactions and text selection',()=>{
 const row={...task('Кликабельная карточка','SUBMITTED'),description:'Текст для копирования',request:{state:'SUBMITTED',executorId:null,author:{id:'author',name:'Автор'}}};
 const onOpen=vi.fn(),titleButtonRef=vi.fn();
 render(<RequestActionsContext.Provider value={true}><RequestBoardPresentation tasks={[row]} beznal onOpen={onOpen} titleButtonRef={titleButtonRef}/></RequestActionsContext.Provider>);
 const opener=screen.getByRole('button',{name:'Открыть обращение «Кликабельная карточка»'});
 const card=opener.closest('article')!;
 expect(screen.queryByRole('button',{name:'Открыть карточку'})).toBeNull();
 fireEvent.click(card);expect(onOpen).toHaveBeenCalledExactlyOnceWith(row,opener);
 expect(titleButtonRef).toHaveBeenCalledWith(row.id,opener);
 onOpen.mockClear();fireEvent.click(opener);expect(onOpen).toHaveBeenCalledExactlyOnceWith(row,opener);
 onOpen.mockClear();fireEvent.click(screen.getByRole('button',{name:'Прикрепить файл'}));expect(onOpen).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Описание полностью'}));expect(screen.getByRole('dialog',{name:'Описание обращения'})).toBeVisible();expect(onOpen).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Закрыть'}));
 const text=within(card).getByText('Текст для копирования');
 const selection=window.getSelection()!,range=document.createRange();range.selectNodeContents(text);selection.removeAllRanges();selection.addRange(range);
 fireEvent.click(text);expect(onOpen).not.toHaveBeenCalled();selection.removeAllRanges();
 fireEvent.click(text);expect(onOpen).toHaveBeenCalledExactlyOnceWith(row,opener);
});

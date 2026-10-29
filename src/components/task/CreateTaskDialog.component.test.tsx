vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor,act} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {CreateTaskDialog} from './CreateTaskDialog';
const mocks=vi.hoisted(()=>({post:vi.fn(),fetch:vi.fn(),upload:vi.fn(),push:vi.fn()}));
vi.mock('@/lib/api',()=>({apiPost:mocks.post,apiFetch:mocks.fetch}));
vi.mock('next-auth/react',()=>({useSession:()=>({status:'authenticated',data:{user:{id:'actor-1'}}})}));
vi.mock('./TaskFormAttachments',async()=>({...await vi.importActual<typeof import('./TaskFormAttachments')>('./TaskFormAttachments'),TaskFormAttachments:({onChange,disabled}:{onChange:(f:File[])=>void;disabled:boolean})=><input aria-label="Файлы для вложения" type="file" disabled={disabled} onChange={e=>onChange(Array.from(e.target.files??[]))}/>,uploadTaskAttachments:mocks.upload}));
beforeEach(()=>{mocks.post.mockImplementation(async(url:string)=>url==='/api/tasks'?{taskId:'new-task'}:{state:'SUBMITTED',version:1});mocks.fetch.mockResolvedValue({marked:false,state:null,version:0});mocks.upload.mockResolvedValue(undefined);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
function mount(claim:boolean|"beznal"=false,canCreate=true){const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),close=vi.fn();const element=(open=true)=><QueryClientProvider client={client}><CreateTaskDialog projectId="project-1" projectName={claim==='beznal'?'Безнал ОП':claim?'Претензии клиентов':'Техподдержка и ИТ'} canCreate={canCreate} open={open} onClose={close}/></QueryClientProvider>;const view=render(element());return {...view,close,rerenderOpen:(v:boolean)=>view.rerender(element(v))};}
function fill(){fireEvent.change(screen.getByLabelText('Кратко о проблеме'),{target:{value:'Проблема с гарнитурой'}});}
function submit(){fireEvent.submit(screen.getByLabelText('Кратко о проблеме').closest('form')!);}

it('allows replacing only refused files on a created draft and does not recreate its frozen body',async()=>{
 mocks.upload.mockRejectedValueOnce(Object.assign(new Error('invalid'),{status:422}));
 const {close}=mount();fill();const first=new File(['bad'],'bad.pdf',{type:'application/pdf'}),next=new File(['good'],'good.pdf',{type:'application/pdf'});
 fireEvent.change(screen.getByLabelText('Файлы для вложения'),{target:{files:[first]}});submit();
 expect(await screen.findByRole('alert')).toHaveTextContent('сервер отклонил формат');
 expect(screen.getByLabelText('Кратко о проблеме')).toBeDisabled();expect(screen.getByLabelText('Файлы для вложения')).not.toBeDisabled();
 fireEvent.change(screen.getByLabelText('Файлы для вложения'),{target:{files:[next]}});submit();
 await waitFor(()=>expect(close).toHaveBeenCalledOnce());
 expect(mocks.post.mock.calls.filter(call=>call[0]==='/api/tasks')).toHaveLength(1);
 expect(mocks.upload.mock.calls).toEqual([['new-task',[first]],['new-task',[next]]]);
});

it('keeps an uncertain upload note separate from the actual later submit rejection',async()=>{
 mocks.upload.mockRejectedValueOnce(Object.assign(new Error('unavailable'),{status:503}));
 const {close}=mount();fill();fireEvent.change(screen.getByLabelText('Файлы для вложения'),{target:{files:[new File(['pdf'],'a.pdf',{type:'application/pdf'})]}});submit();
 expect(await screen.findByRole('alert')).toHaveTextContent('недоступна на сервере');
 expect(screen.getByRole('note')).toHaveTextContent('загрузка файлов не подтверждена');expect(screen.getByLabelText('Файлы для вложения')).toBeDisabled();
 mocks.post.mockRejectedValueOnce(Object.assign(new Error('route'),{status:409,payload:{error:{code:'LIFECYCLE_COLUMNS_REQUIRED'}}}));
 fireEvent.click(screen.getByRole('button',{name:'Продолжить без подтверждённых файлов'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Маршрут отдела не настроен');
 expect(screen.getByRole('note')).toHaveTextContent('загрузка файлов не подтверждена');expect(mocks.upload).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
});

it('replaces a definitively stale submit intent with a new operation and fresh version only on the next retry',async()=>{
 mocks.post.mockImplementationOnce(async()=>({taskId:'new-task'})).mockRejectedValueOnce(Object.assign(new Error('stale'),{status:409,payload:{error:{code:'STALE_TASK_VERSION'}}})).mockResolvedValue({state:'SUBMITTED'});
 mocks.fetch.mockResolvedValueOnce({state:'DRAFT',version:1}).mockResolvedValueOnce({state:'DRAFT',version:2});
 const {close}=mount();fill();submit();await screen.findByRole('alert');expect(mocks.post).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'Повторить отправку'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());
 const previous=mocks.post.mock.calls[1][1],next=mocks.post.mock.calls[2][1];
 expect(previous.expectedVersion).toBe(1);expect(next.expectedVersion).toBe(2);expect(next.operationId).not.toBe(previous.operationId);
 expect(mocks.post.mock.calls.filter(call=>call[0]==='/api/tasks')).toHaveLength(1);
});
describe('real request creation',()=>{
 it('submits the other support category without changing the canonical command',async()=>{const {close}=mount();fill();fireEvent.click(screen.getByRole('button',{name:'Другое'}));expect(screen.getByRole('button',{name:'Другое'})).toHaveAttribute('aria-pressed','true');submit();await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls[0][1].requestDetails).toEqual({kind:'it',category:'Другое'});expect(mocks.post.mock.calls[1][1].action).toBe('submit');});
 it('does not offer a form without permission',()=>{mount(false,false);expect(screen.getByRole('alert')).toHaveTextContent('нет права');expect(screen.queryByRole('textbox')).not.toBeInTheDocument();expect(mocks.post).not.toHaveBeenCalled();});
 it('validates title before any write',()=>{mount();submit();expect(screen.getByRole('alert')).toHaveTextContent('Название обязательно');expect(mocks.post).not.toHaveBeenCalled();});
 it('creates and submits through the canonical versioned command',async()=>{const {close}=mount();fill();submit();await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.push).toHaveBeenCalledWith('/projects/project-1/tasks/new-task',{scroll:false});expect(mocks.post.mock.calls[0]).toEqual(['/api/tasks',expect.objectContaining({projectId:'project-1',priority:'LOW',requestDetails:{kind:'it',category:'Программы и CRM'},operationId:expect.any(String)})]);expect(mocks.post.mock.calls[1]).toEqual(['/api/tasks/new-task',expect.objectContaining({action:'submit',expectedVersion:0,operationId:expect.any(String)})]);});
 it('keeps exact creation intent after unknown network result',async()=>{mocks.post.mockRejectedValueOnce(new Error('network'));const {close}=mount();fill();submit();await screen.findByRole('alert');expect(screen.getByLabelText('Кратко о проблеме')).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Повторить отправку'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());const creations=mocks.post.mock.calls.filter(c=>c[0]==='/api/tasks');expect(creations).toHaveLength(2);expect(creations[1][1]).toEqual(creations[0][1]);});
 it('never replays an attachment upload after an unknown result',async()=>{mocks.upload.mockRejectedValueOnce(new Error('upload'));const {close}=mount();fill();fireEvent.change(screen.getByLabelText('Файлы для вложения'),{target:{files:[new File(['example'],'demo.pdf',{type:'application/pdf'})]}});submit();await screen.findByRole('alert');expect(screen.getByRole('note')).toHaveTextContent('загрузка файлов не подтверждена');fireEvent.click(screen.getByRole('button',{name:'Продолжить без подтверждённых файлов'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls.filter(c=>c[0]==='/api/tasks')).toHaveLength(1);expect(mocks.upload).toHaveBeenCalledTimes(1);});
 it('reuses exact submit operation after unknown result',async()=>{mocks.post.mockImplementationOnce(async()=>({taskId:'new-task'})).mockRejectedValueOnce(new Error('lost ack')).mockResolvedValue({state:'SUBMITTED'});const {close}=mount();fill();submit();await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Повторить отправку'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls[2]).toEqual(mocks.post.mock.calls[1]);expect(mocks.post.mock.calls.filter(c=>c[0]==='/api/tasks')).toHaveLength(1);});
 it('does not submit again when authoritative snapshot is already submitted',async()=>{mocks.fetch.mockResolvedValue({state:'SUBMITTED',version:1,marked:true});const {close}=mount();fill();submit();await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post).toHaveBeenCalledTimes(1);});
 it('requires claim contacts and sends typed customer data',async()=>{const {close}=mount(true);fill();submit();await screen.findByRole('alert');expect(mocks.post).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText('Номер заказа'),{target:{value:'5305316'}});fireEvent.change(screen.getByLabelText('Телефон клиента'),{target:{value:'+7 000 000-00-00'}});fireEvent.click(screen.getByLabelText('Срочно'));submit();await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls[0][1]).toMatchObject({priority:'URGENT',requestDetails:{kind:'claim',order:'5305316',phone:'+7 000 000-00-00'}});});
 it('prevents double submit and Escape dismissal while pending',async()=>{let done!:(v:unknown)=>void;mocks.post.mockImplementationOnce(()=>new Promise(r=>done=r));const {close}=mount();fill();submit();submit();expect(mocks.post).toHaveBeenCalledTimes(1);fireEvent.keyDown(document,{key:'Escape'});expect(close).not.toHaveBeenCalled();await act(async()=>done({taskId:'new-task'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());});
 it('does not upload or submit an intent whose dialog was closed and reopened',async()=>{let done!:(v:unknown)=>void;mocks.post.mockImplementationOnce(()=>new Promise(r=>done=r));const view=mount();fill();submit();view.rerenderOpen(false);view.rerenderOpen(true);await act(async()=>done({taskId:'new-task'}));expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();expect(view.close).not.toHaveBeenCalled();});
});

it('creates a department request when the personal checkbox is clear',async()=>{const {close}=mount();fill();expect(screen.getByRole('checkbox',{name:/^Персональная заявка/})).not.toBeChecked();submit();await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls[0][1].audience).toEqual({mode:'DEPARTMENT',userIds:[]});});
it('requires a selected person and freezes that exact audience on a retry',async()=>{mocks.fetch.mockImplementation(async(url:string)=>url.includes('request-recipients')?{recipients:[{id:'support-1',name:'Сотрудник поддержки 1'},{id:'support-2',name:'Сотрудник поддержки 2'}]}:{marked:true,state:'DRAFT',version:0});mocks.post.mockRejectedValueOnce(new Error('lost response'));const {close}=mount();fireEvent.change(screen.getByLabelText('Кратко о проблеме'),{target:{value:'Личный вопрос'}});fireEvent.click(screen.getByRole('checkbox',{name:/^Персональная заявка/}));expect(screen.getByRole('button',{name:'Отправить обращение'})).toBeDisabled();fireEvent.click(await screen.findByRole('checkbox',{name:'Сотрудник поддержки 1'}));expect(screen.getByRole('button',{name:'Отправить обращение'})).toBeEnabled();submit();await screen.findByRole('alert');expect(mocks.post.mock.calls[0][1].audience).toEqual({mode:'SELECTED',userIds:['support-1']});expect(screen.getByRole('checkbox',{name:'Сотрудник поддержки 2'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Повторить отправку'}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(mocks.post.mock.calls[1][1]).toEqual(mocks.post.mock.calls[0][1]);});
it('does not fall back to the whole department when recipient loading fails',async()=>{mocks.fetch.mockRejectedValue(new Error('offline'));mount();fireEvent.click(screen.getByRole('checkbox',{name:/^Персональная заявка/}));await screen.findByText('Не удалось загрузить сотрудников. Отправка пока недоступна.');expect(screen.getByRole('button',{name:'Отправить обращение'})).toBeDisabled();expect(mocks.post).not.toHaveBeenCalled();});


describe('Безнал ОП demo common form',()=>{
 it('keeps theme, description, urgency, files and audience without a bank section',async()=>{
  const {close}=mount('beznal');
  const topic=screen.getByLabelText('Тема'),description=screen.getByLabelText('Описание (необязательно)');
  expect(topic).toBeRequired();expect(description).not.toBeRequired();
  expect(topic.compareDocumentPosition(description)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(description.compareDocumentPosition(screen.getByLabelText('Не срочно'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByLabelText('Не срочно')).toBeChecked();
  expect(screen.getByLabelText('Файлы для вложения')).toBeEnabled();
  expect(screen.getByRole('checkbox',{name:/^Персональная заявка/})).not.toBeChecked();
  expect(screen.queryByText('Что случилось?')).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Данные по безналу'})).not.toBeInTheDocument();
  for(const label of ['Организация или плательщик (необязательно)','Сумма, ₽ (необязательно)','Дата поступления платежа (необязательно)','Назначение платежа (необязательно)'])expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  fireEvent.change(topic,{target:{value:'Нужен счёт'}});fireEvent.submit(topic.closest('form')!);
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(mocks.post.mock.calls[0][1]).toMatchObject({priority:'LOW',audience:{mode:'DEPARTMENT',userIds:[]}});
  expect(mocks.post.mock.calls[0][1].requestDetails).toEqual({kind:'beznal',category:'Безнал ОП'});
  expect(mocks.post.mock.calls[1][1].action).toBe('submit');
 });
 it('submits common description, urgent priority, file and selected audience with minimal metadata',async()=>{
  mocks.fetch.mockImplementation(async(url:string)=>url.includes('request-recipients')?{recipients:[{id:'accountant-1',name:'Бухгалтер тестовый'}]}:{marked:false,state:'DRAFT',version:0});
  mocks.upload.mockResolvedValue([{url:'/invoice.pdf',name:'invoice.pdf',mime:'application/pdf',size:7}]);
  const {close}=mount('beznal');const topic=screen.getByLabelText('Тема');
  fireEvent.change(topic,{target:{value:'Определить платёж'}});
  fireEvent.change(screen.getByLabelText('Описание (необязательно)'),{target:{value:'Договор 17\nБез НДС'}});
  fireEvent.click(screen.getByLabelText('Срочно'));
  fireEvent.click(screen.getByRole('checkbox',{name:/^Персональная заявка/}));
  fireEvent.click(await screen.findByRole('checkbox',{name:'Бухгалтер тестовый'}));
  const invoice=new File(['invoice'],'invoice.pdf',{type:'application/pdf'});
  fireEvent.change(screen.getByLabelText('Файлы для вложения'),{target:{files:[invoice]}});
  fireEvent.submit(topic.closest('form')!);
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(mocks.post.mock.calls[0][1]).toMatchObject({title:'Определить платёж',description:'Договор 17\nБез НДС',priority:'URGENT',audience:{mode:'SELECTED',userIds:['accountant-1']}});
  expect(mocks.post.mock.calls[0][1].requestDetails).toEqual({kind:'beznal',category:'Безнал ОП'});
  expect(mocks.upload).toHaveBeenCalledExactlyOnceWith('new-task',[invoice]);
  expect(mocks.post.mock.calls[1][1]).toMatchObject({action:'submit',expectedVersion:0});
 });
});

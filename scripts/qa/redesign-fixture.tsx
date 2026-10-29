import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Sidebar } from '../../src/components/layout/sidebar';
import { QuickStart } from '../../src/components/dashboard/QuickStart';
import { KanbanCardView, type TaskType } from '../../src/components/kanban/Card';
import { RequestDialogProvider, RequestDialogLink, useRequestDialog } from '../../src/components/task/RequestDialogProvider';
import { RequestBoardPresentation } from '../../src/components/kanban/RequestBoardPresentation';
import { RequestActionsContext } from '../../src/components/task/RequestQuickTake';
import { encodeRequestDescription } from '../../src/lib/request-presentation';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const task: TaskType = {
  id: 'synthetic-task', projectId: 'support', title: ('Не работает CRM на рабочем компьютере: при попытке открыть заказ появляется ошибка, требуется помощь специалиста. ').repeat(2).slice(0, 200),
  description: encodeRequestDescription('После входа не открывается список заказов. Нужна помощь специалиста.', { kind: 'it', category: 'Программы и CRM' }),
  priority: 'LOW', position: 0, version: 0, createdAt: new Date(Date.now() - 240000).toISOString(),
  createdBy: { id: 'synthetic-author', name: 'Анна Примерова', primaryDepartment: { name: 'Контактный центр' } },
  request: { state: 'SUBMITTED', executorId: null }, assignees: [],
};
const claim: TaskType = {
  ...task, id: 'claim-task', projectId: 'claim', title: 'Клиент просит повторный выезд мастера', priority: 'URGENT',
  description: encodeRequestDescription('Проверить качество выполненной работы.', { kind: 'claim', category: 'Качество', order: '5305316', phone: '+7 000 000-00-00', client: 'Синтетический клиент', want: 'Повторный выезд' }),
};
const boardTasks: TaskType[] = [task, claim,
  { ...task, id: 'progress-task', title: 'Специалист проверяет телефонию', request: { state: 'IN_PROGRESS', executorId: 'synthetic-actor' }, assignees: [{ id: 'synthetic-assignee', user: { id: 'synthetic-actor', name: 'Тестовый сотрудник', email: 'fixture@example.invalid' } }] },
  { ...task, id: 'waiting-task', title: 'Нужны подробности от сотрудника', request: { state: 'NEEDS_INFO', executorId: 'synthetic-actor' } },
  { ...task, id: 'completed-task', title: 'Доступ восстановлен', request: { state: 'COMPLETED', executorId: 'synthetic-actor' } },
  { ...task, id: 'closed-task', title: 'Закрытое синтетическое обращение', request: { state: 'CLOSED', executorId: 'synthetic-actor' } },
];
Object.assign(window, { __fixtureTasks: boardTasks });
function Fixture() {
  const [collapsed, setCollapsed] = useState(false), [executor, setExecutor] = useState(true);
  const open = useRequestDialog()!;
  return <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <div style={{ display: 'flex', height: '100dvh' }}>
      <aside className="hidden md:flex" style={{ width: collapsed ? 60 : 240, flexShrink: 0 }}><Sidebar isCollapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} /></aside>
      <main className="home-shell" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <header className="home-hero"><p className="home-hero-eyebrow">Изолированная проверка реальных компонентов</p><h1>Куда вам нужно обратиться?</h1><p>Синтетические данные. Запросы не отправляются на рабочий сайт.</p></header>
        <QuickStart directions={{ support: { projectId: 'support', projectName: 'Техподдержка и ИТ' }, claim: { projectId: 'claim', projectName: 'Претензии клиентов' } }} canSetupDirections={false} />
        <section className="mt-6 space-y-4"><h2 className="text-xl font-bold">Новые обращения</h2><button className="min-h-11 rounded-lg border px-4" onClick={() => setExecutor(!executor)}>{executor ? 'Роль: исполнитель' : 'Роль: заявитель'}</button>
          <RequestActionsContext.Provider value={executor}><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(290px,100%),1fr))', gap: 16 }}>
            <KanbanCardView task={task} onOpen={opener => open({ projectId: task.projectId, taskId: task.id }, opener)} /><KanbanCardView task={claim} onOpen={opener => open({ projectId: claim.projectId, taskId: claim.id }, opener)} />
          </div></RequestActionsContext.Provider>
        </section>
        <RequestDialogLink projectId="support" taskId="synthetic-task" className="inline-flex min-h-11 items-center underline">Открыть обращение из списка</RequestDialogLink>
        <section aria-label="Проверка доски" className="mt-6">
          <h2 className="text-xl font-bold">Доска обращений</h2>
          <RequestActionsContext.Provider value={executor}><RequestBoardPresentation tasks={boardTasks} onOpen={(selected, opener) => open({ projectId: selected.projectId, taskId: selected.id }, opener)} /></RequestActionsContext.Provider>
        </section>
      </main>
    </div>
  </ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><RequestDialogProvider><Fixture /></RequestDialogProvider></QueryClientProvider>);

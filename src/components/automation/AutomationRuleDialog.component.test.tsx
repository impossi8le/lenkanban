import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutomationRuleDialog } from './AutomationRuleDialog';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it('keeps a failed rule submission open and exposes a retryable error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>
    <AutomationRuleDialog open onOpenChange={() => {}} projectId="test-project" />
  </QueryClientProvider>);
  await user.type(screen.getByLabelText('Название'), 'Тестовое правило');
  await user.click(screen.getByRole('button', {name:'Добавить действие'}));
  await user.click(screen.getByRole('button', {name:'Создать правило'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось создать правило');
  expect(screen.getByRole('button', {name:'Создать правило'})).toBeEnabled();
});

it('offers the shared action catalog and submits the selected notification', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>
    <AutomationRuleDialog open onOpenChange={() => {}} projectId="test-project" />
  </QueryClientProvider>);
  await user.type(screen.getByLabelText('Название'), 'Уведомление');
  await user.click(screen.getByRole('button', {name:'Добавить действие'}));
  screen.getByRole('combobox', {name:'Тип действия 1'}).focus();
  await user.keyboard('[ArrowDown]');
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Уведомить исполнителей', 'Уведомить создателя', 'Переместить в колонку', 'Изменить приоритет', 'Назначить исполнителя']);
  await user.click(screen.getByRole('option', { name: 'Уведомить создателя' }));
  await user.type(screen.getByPlaceholderText('Заголовок уведомления'), 'synthetic title');
  await user.type(screen.getByPlaceholderText('Текст уведомления'), 'synthetic message');
  await user.click(screen.getByRole('button', {name:'Создать правило'}));
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({actions:[{type:'notify_creator',params:{title:'synthetic title',message:'synthetic message'}}]});
  expect(screen.queryByPlaceholderText('ID пользователя')).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('ID колонки')).not.toBeInTheDocument();
});

it('renders viewport-bounded responsive dialog container with reachable actions', async () => {
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}>
    <AutomationRuleDialog open onOpenChange={() => {}} projectId="test-project" />
  </QueryClientProvider>);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Создать правило' })).toBeInTheDocument();
});

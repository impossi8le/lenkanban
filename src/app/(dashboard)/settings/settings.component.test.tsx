import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ data: null as null | { user: { name: string; email: string; id: string } } }));
vi.mock('next-auth/react', () => ({ useSession: () => ({data:auth.data, update:vi.fn()}) }));
import SettingsPage from './page';

it('populates asynchronously loaded profile without overwriting an in-progress edit', async () => {
  auth.data = null;
  const ui = render(<SettingsPage />);
  auth.data = {user:{name:'Павел',email:'pavel@example.invalid',id:'user1'}};
  ui.rerender(<SettingsPage />);
  expect(screen.getByLabelText('Имя')).toHaveValue('Павел');
  await userEvent.clear(screen.getByLabelText('Имя'));
  await userEvent.type(screen.getByLabelText('Имя'), 'Новое имя');
  auth.data = {user:{...auth.data.user,name:'Другое серверное имя'}};
  ui.rerender(<SettingsPage />);
  expect(screen.getByLabelText('Имя')).toHaveValue('Новое имя');
});

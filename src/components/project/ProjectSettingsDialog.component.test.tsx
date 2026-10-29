import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

it("saves the general project settings and clears a description with the API's null contract", async () => {
  const writes: unknown[] = [];
  const project = { id: "project", name: "Ремонт", description: "Старое описание", ownerId: "owner" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url !== "/api/projects/project") throw new Error(`Unexpected endpoint: ${url}`);
    if (options?.method === "PATCH") writes.push(JSON.parse(String(options.body)));
    return Response.json({ success: true, data: project });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onOpenChange = vi.fn();
  render(<QueryClientProvider client={client}><ProjectSettingsDialog projectId="project" open onOpenChange={onOpenChange} /></QueryClientProvider>);
  const name = await screen.findByRole("textbox", { name: "Название проекта" });
  await userEvent.clear(name);
  expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  await userEvent.type(name, "  Новый проект  ");
  await userEvent.clear(screen.getByRole("textbox", { name: "Описание" }));
  await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(writes).toEqual([{ name: "Новый проект", description: null }]));
  await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

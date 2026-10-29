import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessageDTO } from "@/lib/chat-types";

vi.mock("@/lib/attachments/prepare-image", () => ({ prepareImagesForUpload: async (files: File[]) => files }));

const socket = vi.hoisted(() => ({ connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock("@/hooks/useTaskChat", () => ({ useTaskChat: () => ({ socket, isConnected: true, isJoined: true, lastError: null }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "user-1", name: "User", email: "user@example.test", image: null } } }) }));
import { TaskChatPanel } from "./TaskChatPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); });

it("adds a complete optimistic message DTO while awaiting socket delivery", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [], nextCursor: null } }), { headers: { "Content-Type": "application/json" } })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TaskChatPanel taskId="task-1" /></QueryClientProvider>);
  await screen.findByText("Пока нет сообщений");
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Сообщение... (Enter — отправить)"), "Hello");
  await user.keyboard("{Enter}");
  await screen.findByText("отправляется…");
  const message = client.getQueryData<{ items: ChatMessageDTO[] }>(["task-messages", "task-1"])?.items[0];
  expect(message).toMatchObject({ contentText: "Hello", taskId: "task-1", authorId: "user-1", attachments: [], mentions: [], reactions: {} });
  await waitFor(() => expect(socket.emit).toHaveBeenCalledWith("message:send", expect.objectContaining({ taskId: "task-1", contentText: "Hello" }), expect.any(Function)));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)); });
  expect(socket.emit).toHaveBeenCalledWith("typing", { taskId: "task-1", isTyping: false });
});

it("Shift+Enter inserts a line and composition/repeated Enter never sends prematurely", async () => {
  socket.emit.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: { items: [], nextCursor: null } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TaskChatPanel taskId="task-keyboard" /></QueryClientProvider>);
  await screen.findByText("Пока нет сообщений");
  const field = screen.getByRole("textbox", { name: "Сообщение" });
  const user = userEvent.setup();
  await user.type(field, "First");
  await user.keyboard("{Shift>}{Enter}{/Shift}Second");
  expect(field).toHaveValue("First\nSecond");
  expect(socket.emit.mock.calls.some(([event]) => event === 'message:send')).toBe(false);
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
  fireEvent.keyDown(field, { key: 'Enter', repeat: true });
  expect(socket.emit.mock.calls.some(([event]) => event === 'message:send')).toBe(false);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('message:send', expect.objectContaining({ contentText: 'First\nSecond' }), expect.any(Function)));
  expect(socket.emit.mock.calls.filter(([event]) => event === 'message:send')).toHaveLength(1);
  client.clear();
});


async function mountMessageActions(marked: boolean) {
  socket.emit.mockReset();
  const message = { id: "message-action", taskId: "task-action", clientId: "message-client", authorId: "user-1",
    contentText: "Original message", version: 7, canEdit: !marked, canDelete: !marked, attachments: [], mentions: [], reactions: { "👍": ["other"] }, readBy: {},
    createdAt: "2026-10-26T00:00:00.000Z", author: { id: "user-1", name: "User", email: "user@example.test", avatarUrl: null } };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" ? Response.json({ error: { code: "FORBIDDEN", message: "SYNTHETIC_SECRET" } }, { status: 403 }) : new Response(JSON.stringify({ success: true,
    data: String(input).includes("/lifecycle") ? { marked } : { items: [message], nextCursor: null },
  }), { headers: { "Content-Type": "application/json" } })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["task-lifecycle", "task-action", "user-1"], { marked });
  render(<QueryClientProvider client={client}><TaskChatPanel taskId="task-action" /></QueryClientProvider>);
  await screen.findByText("Original message");
  return userEvent.setup();
}

it("does not advertise editing or deleting without fresh message capabilities", async () => {
  await mountMessageActions(true);
  expect(screen.queryByRole("button", { name: "Изменить сообщение" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Удалить сообщение" })).toBeNull();
  expect(screen.getByRole("button", { name: "Добавить реакцию" })).toBeInTheDocument();
});

it("keeps the message editor open and reports a refused versioned save without raw server errors", async () => {
  const user = await mountMessageActions(false);
  socket.emit.mockImplementation((event: string, _payload: unknown, ack?: (value: unknown) => void) => {
    if (event === "message:edit") ack?.({ ok: false, error: "SYNTHETIC_SECRET" });
  });
  await user.click(await screen.findByRole("button", { name: "Изменить сообщение" }));
  const editor = screen.getByDisplayValue("Original message");
  await user.clear(editor); await user.type(editor, "Changed message");
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось изменить сообщение");
  expect(screen.getByDisplayValue("Changed message")).toBeInTheDocument();
  expect(screen.queryByText(/SYNTHETIC_SECRET/)).toBeNull();
});

it("reports a refused request reaction instead of silently dropping it", async () => {
  const user = await mountMessageActions(true);
  socket.emit.mockImplementation((event: string, _payload: unknown, ack?: (value: unknown) => void) => {
    if (event === "message:react") ack?.({ ok: false, error: "MutationRejected" });
  });
  await user.click(screen.getByRole("button", { name: "👍1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось изменить реакцию");
});


it("reports a lost mutation acknowledgement after a bounded wait", async () => {
  await mountMessageActions(true);
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "👍1" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.getByRole("alert")).toHaveTextContent("Сервер не подтвердил действие");
  } finally { vi.useRealTimers(); }
});


it("rejects too many photos before creating previews or making upload requests", async () => {
 const fetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => Response.json({ success: true, data: { items: [], nextCursor: null } }));
 vi.stubGlobal("fetch", fetch); const create = vi.fn(); Object.defineProperty(URL, "createObjectURL", { configurable:true,value:create });
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><TaskChatPanel taskId="photo-limits" /></QueryClientProvider>);
 await screen.findByText("Пока нет сообщений");
 fireEvent.change(screen.getByLabelText("Прикрепить файлы к сообщению"), { target:{files:Array.from({length:6},(_,i)=>new File(["photo"], `${i}.jpg`,{type:"image/jpeg"}))} });
 expect(await screen.findByRole("alert")).toHaveTextContent("не более 5");
 expect(create).not.toHaveBeenCalled(); expect(fetch.mock.calls.some(call=>String(call[0]).includes("/uploads/"))).toBe(false);
 client.clear();
});

it("keeps a photo preview alive across upload completion and revokes it when removed", async () => {
 const create=vi.fn(()=>"blob:photo"), revoke=vi.fn();
 Object.defineProperty(URL,"createObjectURL",{configurable:true,value:create}); Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:revoke});
 vi.stubGlobal("fetch",vi.fn(async (input: RequestInfo | URL) => {
 const path=String(input); let data:unknown={items:[],nextCursor:null};
 if(path.includes("presign")) data={uploadUrl:"/upload-bytes",method:"PUT",headers:{},token:"upload-token"};
 if(path.includes("finalize")) data={attachment:{url:"/photo",name:"photo.jpg",size:5,mime:"image/jpeg"}};
 return Response.json({success:true,data});
 }));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><TaskChatPanel taskId="photo-preview" /></QueryClientProvider>);
 await screen.findByText("Пока нет сообщений");
 fireEvent.change(screen.getByLabelText("Прикрепить файлы к сообщению"),{target:{files:[new File(["photo"],"photo.jpg",{type:"image/jpeg"})]}});
 await waitFor(()=>expect(create).toHaveBeenCalledOnce());
 await waitFor(()=>expect(view.container.querySelector('img[src="blob:photo"]')).not.toBeNull());
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).includes("finalize"))).toBe(true));
 await waitFor(()=>expect(screen.queryByText("Загрузка…")).toBeNull());
 expect(revoke).not.toHaveBeenCalled();
 view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:photo"); client.clear();
});

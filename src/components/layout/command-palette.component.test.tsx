import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {apiFetch} from "@/lib/api";
import { CommandPalette } from "./command-palette";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "test-actor" } } }) }));
// The empty palette now reads recent requests; no test may reach the network.
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => []) }));

const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
afterEach(() => {
  cleanup();
  if (previousScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("names the search dialog and restores focus to its trigger after Escape", async () => {
  // jsdom has no layout/scrollIntoView; geometry is checked in the real browser.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><CommandPalette /></QueryClientProvider>);
  const trigger = screen.getByRole("button", { name: "Поиск обращений и направлений" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  view.unmount();
  client.clear();
});

it("shows and highlights the actual late description match and still opens the request", async()=>{
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
 vi.mocked(apiFetch).mockImplementation(async(url)=>String(url).startsWith("/api/tasks?search=")?[{id:"late-search",title:"Счёт поставщику",description:"Начало без совпадения. ".repeat(40)+"Поступила оплата Альфа",projectId:"board-1",project:{name:"Бухгалтерия"},request:{state:"IN_PROGRESS",author:{name:"Анна"}}}]:[]);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><CommandPalette/></QueryClientProvider>);
 fireEvent.click(screen.getByRole("button",{name:"Поиск обращений и направлений"}));
 fireEvent.change(await screen.findByPlaceholderText("Найти обращение или направление…"),{target:{value:"оплата Альфа"}});
 const result=await screen.findByRole("option",{name:/Счёт поставщику/});
 expect(result.textContent).toContain("Описание:");expect([...result.querySelectorAll("mark")].map(node=>node.textContent)).toEqual(["оплата","Альфа"]);
 expect(result.textContent).toContain("Бухгалтерия");expect(result.textContent).toContain("Анна");fireEvent.click(result);
 await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());client.clear();
});

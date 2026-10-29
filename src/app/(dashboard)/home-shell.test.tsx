import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const pending = new Promise(() => {});
vi.mock("@/components/dashboard/HomeData", () => ({
  HomeActiveCount: () => { throw pending; }, HomeReplyBanner: () => { throw pending; }, HomeRecentRequests: () => { throw pending; },
}));
import DashboardHome from "./page";

it("renders the public hero, working department links and local loading states while all personal data is pending", () => {
  const page = DashboardHome();
  expect(page).not.toBeInstanceOf(Promise);
  const html = renderToStaticMarkup(page);
  expect(html).toContain("Куда вам нужно обратиться?");
  expect(html).toContain("Написать в Техподдержку");
  expect(html).toContain("Передать недовольного клиента");
  expect(html).toContain('/departments/support?create=task');
  expect(html).toContain('/departments/claim?create=task');
  expect(html).toContain("Последние обращения");
  expect(html).toContain("Загрузка обращений…");
  expect(html).toContain("Загрузка количества обращений");
  expect(html).not.toContain(">0<");
  expect(html).not.toContain("Здесь появятся ваши обращения");
});

import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { HomeActiveCount, HomeRecentRequests, HomeReplyBanner } from "@/components/dashboard/HomeData";
import { DepartmentQuickStart } from "@/components/dashboard/DepartmentQuickStart";

/** Public shell streams immediately; every personal section authorizes its own request. */
export default function DashboardHome() {
  return <div className="h-full overflow-y-auto"><div className="home-shell">
    <section className="home-hero" aria-labelledby="home-hero-heading">
      <div><p className="home-hero-eyebrow">Помощь коллег — в одном месте</p><h1 id="home-hero-heading">Куда вам нужно обратиться?</h1><p>Выберите отдел и расскажите, что случилось.<br />Здесь будет видно, кто помогает и на каком этапе ваше обращение.</p></div>
      <div className="home-hero-badge"><Suspense fallback={<strong aria-label="Загрузка количества обращений" role="status">…</strong>}><HomeActiveCount /></Suspense><span>ваших активных<br />обращений</span></div>
    </section>
    <h2 className="sr-only">Быстрый старт</h2><DepartmentQuickStart />
    <Suspense fallback={null}><HomeReplyBanner /></Suspense>
    <section className="home-recent-panel" aria-labelledby="home-recent-heading"><div className="home-panel-title"><h2 id="home-recent-heading">Последние обращения</h2><Link href="/my-tasks?scope=mine" className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-primary">Посмотреть все <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></div>
      <Suspense fallback={<div role="status" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />Загрузка обращений…</div>}><HomeRecentRequests /></Suspense>
    </section>
  </div></div>;
}

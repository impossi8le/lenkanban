import Link from "next/link";

export default function RecoveryPage() {
  return (
    <main id="main-content" className="auth-shell">
      <section className="auth-form-panel min-w-0 space-y-6 [overflow-wrap:anywhere]" aria-label="Восстановление доступа">
        <h1 className="text-xl font-semibold">Восстановление доступа</h1>
        <p className="text-sm text-muted-foreground">Восстановление доступа выполняется через корпоративный SSO.</p>
        <Link href="/sign-in" className="text-sm text-primary underline underline-offset-4">Вернуться ко входу</Link>
      </section>
    </main>
  );
}

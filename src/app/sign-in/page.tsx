"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/shared/theme-toggle";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    // Rate-limited preflight (no redirects, stable JSON errors)
    try {
      const pre = await fetch("/api/auth-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!pre.ok) {
        const data = (await pre.json().catch(() => null)) as null | { error?: string; retryAfter?: number };
        if (pre.status === 429) {
          const retryAfter = data?.retryAfter ?? 60;
          setError(`Слишком много попыток. Попробуйте снова через ${retryAfter} сек.`);
          setIsLoading(false);
          return;
        }
        setError("Не удалось выполнить вход");
        setIsLoading(false);
        return;
      }
    } catch {
      // If preflight fails, continue to NextAuth (fail-open)
    }

    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      // The server deliberately returns one generic failure for an unknown
      // address, a wrong password, an unverified address and a blocked account,
      // so the message must stay generic too.
      setError("Неверный логин или пароль");
      setIsLoading(false);
    } else if (res?.ok) {
      window.location.href = "/";
    }
  }

  return (
    <main id="main-content" className="auth-shell">
      <section className="auth-form-panel min-w-0 [overflow-wrap:anywhere]" aria-label="Вход в рабочее пространство">
      <div className="absolute right-5 top-5"><ThemeToggle /></div>
      <form
        onSubmit={onSubmit}
        className="min-w-0 space-y-6"
      >
        <div className="space-y-2 pb-2">
          <h1 className="text-3xl font-semibold tracking-tight">С возвращением</h1>
          <p className="text-sm text-muted-foreground">Войдите, чтобы продолжить работу.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Логин</Label>
          <Input
            id="email"
            type="text"
            autoComplete="username"
            placeholder="barhat"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-describedby={error ? "sign-in-error" : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            aria-describedby={error ? "sign-in-error" : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>

        {error ? (
          <div id="sign-in-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? <><Loader2 className="animate-spin" aria-hidden="true" />Входим…</> : <>Войти<ArrowRight aria-hidden="true" /></>}
        </Button>

        <div className="text-sm text-muted-foreground">
          Нет аккаунта?{" "}
          <Link href="/sign-up" className="text-primary underline underline-offset-4">
            Регистрация
          </Link>
        </div>
      </form>
      </section>
    </main>
  );
}

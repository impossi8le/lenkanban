"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim() || undefined,
        email,
        password,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const code =
        typeof body?.error === "string" ? body.error : body?.error?.code;
      if (code === "EmailAlreadyInUse") {
        setError("Этот email уже используется");
      } else if (code === "REGISTRATION_DISABLED") {
        setError("Самостоятельная регистрация отключена. Обратитесь к администратору.");
      } else {
        setError("Не удалось создать аккаунт");
      }
      setIsLoading(false);
      return;
    }

    // Show success message instead of auto sign-in
    setSuccess(true);
    setIsLoading(false);
  }

  async function resendVerification() {
    setIsLoading(true);
    setError(null);

    const res = await fetch("/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.message || "Не удалось отправить письмо");
    } else {
      setError(null);
      alert("Письмо отправлено повторно. Проверьте почту.");
    }

    setIsLoading(false);
  }

  if (success) {
    return (
      <main id="main-content" className="min-h-[calc(100dvh-56px)] flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-sm min-w-0 [overflow-wrap:anywhere] rounded-xl border bg-card p-4 sm:p-6 space-y-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Проверьте почту</h1>
            <p className="text-sm text-muted-foreground">
              Мы отправили письмо с подтверждением на <strong>{email}</strong>
            </p>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Перейдите по ссылке в письме, чтобы подтвердить email и войти в систему.</p>
            <p>Не получили письмо?</p>
          </div>

          {error && (
            <div role="alert" aria-live="assertive" className="text-sm text-destructive">
              {error}
            </div>
          )}

          <Button
            onClick={resendVerification}
            variant="outline"
            className="w-full h-auto min-h-11 whitespace-normal text-center"
            disabled={isLoading}
          >
            {isLoading ? "Отправляем..." : "Отправить повторно"}
          </Button>

          <div className="text-sm text-muted-foreground text-center">
            <Link href="/sign-in" className="text-primary hover:underline">
              Вернуться ко входу
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-[calc(100dvh-56px)] flex items-center justify-center p-4 sm:p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm min-w-0 [overflow-wrap:anywhere] rounded-xl border bg-card p-4 sm:p-6 space-y-4"
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Регистрация</h1>
          <p className="text-sm text-muted-foreground">Создайте аккаунт</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">Имя</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            aria-describedby={error ? "sign-up-error" : undefined}
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Пароль (мин. 8 символов)</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>

        {error ? (
          <div id="sign-up-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full h-auto min-h-11 whitespace-normal text-center" disabled={isLoading}>
          {isLoading ? "Создаём..." : "Создать аккаунт"}
        </Button>

        <div className="text-sm text-muted-foreground">
          Уже есть аккаунт?{" "}
          <Link href="/sign-in" className="text-primary underline underline-offset-4">
            Войти
          </Link>
        </div>
      </form>
    </main>
  );
}

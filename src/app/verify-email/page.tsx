"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

import { Button } from "@/components/ui/button";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [errorCode, setErrorCode] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Токен не указан");
      return;
    }

    async function verify() {
      try {
        const res = await fetch(`/api/auth/verify-email?token=${token}`);
        const json = await res.json();

        if (res.ok && json.success) {
          setStatus("success");
          setMessage(json.data.message || "Email успешно подтвержден");
          setEmail(json.data.email);

          // Auto redirect to sign-in after 3 seconds
          setTimeout(() => {
            router.push("/sign-in");
          }, 3000);
        } else {
          setStatus("error");
          setErrorCode(json.error?.code || "");
          setMessage(json.error?.message || json.message || "Не удалось подтвердить email");
        }
      } catch (error) {
        setStatus("error");
        setMessage("Произошла ошибка при подтверждении email");
      }
    }

    verify();
  }, [token, router]);

  return (
    <main id="main-content" className="min-h-[calc(100dvh-56px)] flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm min-w-0 [overflow-wrap:anywhere] rounded-xl border bg-card p-4 sm:p-6 space-y-4">
        {status === "loading" && (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Подтверждение email</h1>
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                Проверяем ваш токен...
              </p>
            </div>
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          </>
        )}

        {status === "success" && (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold text-green-600">✓ Успешно!</h1>
              <p className="text-sm text-muted-foreground">{message}</p>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Ваш email <strong>{email}</strong> подтвержден.</p>
              <p>Вы будете перенаправлены на страницу входа через 3 секунды...</p>
            </div>
            <Button asChild className="w-full h-auto min-h-11 whitespace-normal text-center">
              <Link href="/sign-in">Войти сейчас</Link>
            </Button>
          </>
        )}

        {status === "error" && (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold text-destructive">Ошибка</h1>
              <p role="alert" aria-live="assertive" className="text-sm text-muted-foreground">{message}</p>
            </div>
            <div className="space-y-2">
              <Button asChild variant="outline" className="w-full h-auto min-h-11 whitespace-normal text-center">
                <Link href="/sign-in">Вернуться ко входу</Link>
              </Button>
              <Button asChild variant="outline" className="w-full h-auto min-h-11 whitespace-normal text-center">
                <Link href="/sign-up">Зарегистрироваться заново</Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={
      <main id="main-content" className="min-h-[calc(100dvh-56px)] flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-sm min-w-0 [overflow-wrap:anywhere] rounded-xl border bg-card p-4 sm:p-6 space-y-4">
          <div className="flex justify-center py-4">
            <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
          <p role="status" className="sr-only">Загрузка подтверждения email…</p>
        </div>
      </main>
    }>
      <VerifyEmailContent />
    </Suspense>
  );
}

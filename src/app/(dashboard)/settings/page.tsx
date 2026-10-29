"use client";

import { displayLogin } from "@/lib/login-identity";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";

export default function SettingsPage() {
  const { data: session, update } = useSession();
  const [isLoading, setIsLoading] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const name = draftName ?? session?.user?.name ?? "";

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await apiFetch("/api/user/profile", {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });

      // Pass the saved name so the JWT/session update carries it; `update()`
      // without a payload leaves the session name untouched.
      await update({ name });

      toast.success("Профиль обновлен", {
        description: "Ваши изменения сохранены",
      });
    } catch (error) {
      toast.error("Ошибка", {
        description: "Не удалось обновить профиль",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container min-w-0 max-w-4xl py-8 px-4 sm:px-6 ml-0">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Настройки</h1>
          <p className="text-muted-foreground mt-2">
            Управление настройками вашего аккаунта
          </p>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Профиль</CardTitle>
            <CardDescription>
              Обновите информацию вашего профиля
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpdateProfile} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Логин</Label>
                <Input
                  id="email"
                  type="text"
                  value={displayLogin(session?.user?.email)}
                  disabled
                  className="bg-muted"
                />
                <p className="text-sm text-muted-foreground">
                  Логин нельзя изменить
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Имя</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="Введите ваше имя"
                />
              </div>

              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Сохранение..." : "Сохранить изменения"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Информация об аккаунте</CardTitle>
            <CardDescription>
              Детали вашего аккаунта
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground">ID пользователя</Label>
              <p className="text-sm font-mono mt-1">{session?.user?.id}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Роль</Label>
              <p className="text-sm mt-1">
                {session?.user?.globalRole === "ADMIN" ? "Администратор" : "Пользователь"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

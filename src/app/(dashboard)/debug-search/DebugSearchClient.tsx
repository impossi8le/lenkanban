"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function DebugSearchClient() {
  const { data: session, status } = useSession();
  const [searchTerm, setSearchTerm] = useState("test");
  const [tasksResult, setTasksResult] = useState<unknown>(null);
  const [projectsResult, setProjectsResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [cookies, setCookies] = useState<string>("");

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setCookies(document.cookie || "Нет cookies");
    }
  }, []);

  const testSearch = async () => {
    setLoading(true);
    setTasksResult(null);
    setProjectsResult(null);

    try {
      // Test tasks API
      const tasksRes = await fetch(`/api/tasks?search=${encodeURIComponent(searchTerm)}`, {
        credentials: 'include',
      });

      const tasksData = {
        status: tasksRes.status,
        ok: tasksRes.ok,
        headers: Object.fromEntries(tasksRes.headers.entries()),
        body: tasksRes.ok ? await tasksRes.json() : await tasksRes.text(),
      };
      setTasksResult(tasksData);

      // Test projects API
      const projectsRes = await fetch(`/api/projects?search=${encodeURIComponent(searchTerm)}`, {
        credentials: 'include',
      });

      const projectsData = {
        status: projectsRes.status,
        ok: projectsRes.ok,
        headers: Object.fromEntries(projectsRes.headers.entries()),
        body: projectsRes.ok ? await projectsRes.json() : await projectsRes.text(),
      };
      setProjectsResult(projectsData);

    } catch {
      setTasksResult({ error: "Не удалось выполнить поиск" });
      setProjectsResult({ error: "Не удалось выполнить поиск" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto min-w-0 p-4 space-y-6 sm:p-6">
      <h1 className="text-2xl font-bold break-words sm:text-3xl">Диагностика Поиска</h1>

      <Card>
        <CardHeader>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Сессия</h2>
        </CardHeader>
        <CardContent>
          <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <p><strong>Статус:</strong> {status}</p>
            {session?.user && (
              <>
                <p className="[overflow-wrap:anywhere]"><strong>Email:</strong> {session.user.email}</p>
                <p className="[overflow-wrap:anywhere]"><strong>Имя:</strong> {session.user.name}</p>
                <p className="[overflow-wrap:anywhere]"><strong>ID:</strong> {session.user.id}</p>
              </>
            )}
            {!session && <p className="text-red-500">Сессия не найдена!</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Тест Поиска</h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Поисковый запрос"
            />
            <Button onClick={testSearch} disabled={loading}>
              {loading ? "Загрузка..." : "Тест"}
            </Button>
          </div>

          {tasksResult != null && (
            <div className="space-y-2">
              <h3 className="font-semibold">Результат /api/tasks:</h3>
              <div className="bg-muted p-4 rounded-md overflow-auto max-h-96">
                <pre className="text-xs">{JSON.stringify(tasksResult, null, 2)}</pre>
              </div>
            </div>
          )}

          {projectsResult != null && (
            <div className="space-y-2">
              <h3 className="font-semibold">Результат /api/projects:</h3>
              <div className="bg-muted p-4 rounded-md overflow-auto max-h-96">
                <pre className="text-xs">{JSON.stringify(projectsResult, null, 2)}</pre>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Cookies</h2>
        </CardHeader>
        <CardContent>
          <div className="bg-muted p-4 rounded-md overflow-auto">
            <pre className="text-xs">{cookies}</pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

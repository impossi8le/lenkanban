"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from "recharts";
import { TrendingUp, Users, Clock, CheckCircle2, Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { exportAnalyticsToPDF } from "@/lib/export-utils";

interface AnalyticsData {
  tasksByStatus: Array<{ status: string; count: number }>;
  tasksByPriority: Array<{ priority: string; count: number }>;
  velocity: Array<{ week: string; completed: number; date: string }>;
  burndown: Array<{ date: string; remaining: number; ideal: number }>;
  assigneeWorkload: Array<{
    userId: string;
    taskCount: number;
    user: { name: string; email: string } | null;
  }>;
  summary: {
    totalTasks: number;
    completedThisMonth: number;
    overdueTasks: number;
  };
}

interface AnalyticsPageProps {
  projectId?: string;
}

const statusColors = {
  TODO: "var(--muted-foreground)",
  IN_PROGRESS: "var(--info-bright)",
  IN_REVIEW: "var(--warning-bright)",
  DONE: "var(--success-bright)",
};

const priorityColors = {
  CRITICAL: "var(--danger-bright)",
  URGENT: "var(--danger-bright)",
  HIGH: "var(--urgent-bright)",
  MEDIUM: "var(--info-bright)",
  LOW: "var(--muted-foreground)",
};

const statusLabels = {
  TODO: "К выполнению",
  IN_PROGRESS: "В работе",
  IN_REVIEW: "На проверке",
  DONE: "Готово",
};

const priorityLabels = {
  CRITICAL: "Критический",
  URGENT: "Срочно",
  HIGH: "Высокий",
  MEDIUM: "Средний",
  LOW: "Низкий",
};

const tooltipStyle = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};
const chartTick = { fill: "var(--muted-foreground)", fontSize: 12 };

function ChartDataTable({ caption, columns, rows }: {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return <table className="sr-only">
    <caption>{caption}</caption>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>) : <tr><td colSpan={columns.length}>Нет данных</td></tr>}</tbody>
  </table>;
}

export function AnalyticsPage({ projectId }: AnalyticsPageProps) {
  const { data: analytics, isLoading } = useQuery({
    queryKey: ["analytics", projectId],
    queryFn: () => {
      const url = projectId ? `/api/analytics?projectId=${projectId}` : "/api/analytics";
      return apiFetch<AnalyticsData>(url);
    },
  });

  if (isLoading) {
    return (
      <div className="min-w-0 space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <div className="h-4 bg-muted rounded animate-pulse" />
              </CardHeader>
              <CardContent>
                <div className="h-8 bg-muted rounded animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <div className="h-5 bg-muted rounded animate-pulse" />
              </CardHeader>
              <CardContent>
                <div className="h-64 bg-muted rounded animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="min-w-0 p-4 sm:p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">
              Не удалось загрузить аналитику
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusData = analytics.tasksByStatus.map(item => ({
    ...item,
    label: statusLabels[item.status as keyof typeof statusLabels] || item.status,
    fill: statusColors[item.status as keyof typeof statusColors] || "var(--muted-foreground)",
  }));

  const priorityData = analytics.tasksByPriority.map(item => ({
    ...item,
    label: priorityLabels[item.priority as keyof typeof priorityLabels] || item.priority,
    fill: priorityColors[item.priority as keyof typeof priorityColors] || "var(--muted-foreground)",
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="h-full overflow-y-auto space-y-6 p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Аналитика</h1>
          <p className="text-muted-foreground">
            {projectId ? "Статистика проекта" : "Общая статистика по всем проектам"}
          </p>
        </div>
        <Button
          onClick={() => {
            // The PDF stack is imported by the handler, so the click owns its promise.
            void exportAnalyticsToPDF(analytics, projectId ? "Проект" : "Все проекты");
          }}
          variant="outline"
          className="shrink-0 gap-2"
        >
          <Download className="h-4 w-4" />
          Экспорт PDF
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Всего задач</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{analytics.summary.totalTasks}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Выполнено за месяц</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--success-bright)]">
              {analytics.summary.completedThisMonth}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Просрочено</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--danger-bright)]">
              {analytics.summary.overdueTasks}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Активные исполнители</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {analytics.assigneeWorkload.length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tasks by Status */}
        <Card>
          <CardHeader>
            <CardTitle>Задачи по статусам</CardTitle>
            <CardDescription>
              Распределение задач по текущим статусам
            </CardDescription>
          </CardHeader>
          <CardContent role="figure" aria-label="Задачи по статусам">
            <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart accessibilityLayer={false}>
                <Pie
                  rootTabIndex={-1}
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  fill="var(--primary)"
                  dataKey="count"
                  nameKey="label"
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} aria-label={`${entry.label}: ${entry.count}`} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--popover-foreground)" }} itemStyle={{ color: "var(--popover-foreground)" }} />
                <Legend
                  verticalAlign="bottom"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 12 }}
                  payload={statusData.map(entry => ({
                    value: `${entry.label}: ${entry.count}`,
                    type: "circle" as const,
                    color: entry.fill,
                  }))}
                />
              </PieChart>
            </ResponsiveContainer>
            </div>
            <ChartDataTable caption="Задачи по статусам: данные" columns={["Статус", "Задач"]} rows={statusData.map(item => [item.label, item.count])} />
          </CardContent>
        </Card>

        {/* Tasks by Priority */}
        <Card>
          <CardHeader>
            <CardTitle>Задачи по приоритетам</CardTitle>
            <CardDescription>
              Распределение задач по уровням приоритета
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart accessibilityLayer={false} data={priorityData}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis tick={chartTick} stroke="var(--border-emphasis)" dataKey="label" />
                <YAxis tick={chartTick} stroke="var(--border-emphasis)" />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--popover-foreground)" }} itemStyle={{ color: "var(--popover-foreground)" }} />
                <Bar dataKey="count" name="Задач" fill="var(--primary)">
                  {priorityData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            </div>
            <ChartDataTable caption="Задачи по приоритетам: данные" columns={["Приоритет", "Задач"]} rows={priorityData.map(item => [item.label, item.count])} />
          </CardContent>
        </Card>

        {/* Velocity Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Скорость</CardTitle>
            <CardDescription>
              Количество выполненных задач за последние 4 недели
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart accessibilityLayer={false} data={analytics.velocity}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis tick={chartTick} stroke="var(--border-emphasis)" dataKey="week" />
                <YAxis tick={chartTick} stroke="var(--border-emphasis)" />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--popover-foreground)" }} itemStyle={{ color: "var(--popover-foreground)" }} />
                <Line
                  type="monotone"
                  dataKey="completed"
                  name="Выполнено"
                  stroke="var(--info-bright)"
                  strokeWidth={2}
                  dot={{ fill: "var(--info-bright)" }}
                />
              </LineChart>
            </ResponsiveContainer>
            </div>
            <ChartDataTable caption="Скорость: данные" columns={["Неделя", "Выполнено"]} rows={analytics.velocity.map(item => [item.week, item.completed])} />
          </CardContent>
        </Card>

        {/* Burndown Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Диаграмма сгорания задач</CardTitle>
            <CardDescription>
              Оставшиеся задачи за последние 14 дней (идеальная vs фактическая)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart accessibilityLayer={false} data={analytics.burndown}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis tick={chartTick} stroke="var(--border-emphasis)"
                  dataKey="date"
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return `${date.getDate()}/${date.getMonth() + 1}`;
                  }}
                />
                <YAxis tick={chartTick} stroke="var(--border-emphasis)" />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--popover-foreground)" }} itemStyle={{ color: "var(--popover-foreground)" }}
                  labelFormatter={(value) => {
                    const date = new Date(value as string);
                    return date.toLocaleDateString("ru-RU");
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="ideal"
                  stroke="var(--muted-foreground)"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  name="Идеальная"
                />
                <Line
                  type="monotone"
                  dataKey="remaining"
                  stroke="var(--danger-bright)"
                  strokeWidth={2}
                  dot={{ fill: "var(--danger-bright)" }}
                  name="Фактическая"
                />
              </LineChart>
            </ResponsiveContainer>
            </div>
            <ChartDataTable caption="Диаграмма сгорания задач: данные" columns={["Дата", "Осталось", "Идеальная"]} rows={analytics.burndown.map(item => [item.date, item.remaining, item.ideal])} />
          </CardContent>
        </Card>

        {/* Assignee Workload */}
        <Card>
          <CardHeader>
            <CardTitle>Нагрузка исполнителей</CardTitle>
            <CardDescription>
              Количество активных задач у каждого исполнителя
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart accessibilityLayer={false} data={analytics.assigneeWorkload.slice(0, 8)}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis tick={chartTick} stroke="var(--border-emphasis)"
                  dataKey="user.name"
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis tick={chartTick} stroke="var(--border-emphasis)" />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "var(--popover-foreground)" }} itemStyle={{ color: "var(--popover-foreground)" }}
                  formatter={(value) => [value, "Активных задач"]}
                  labelFormatter={(label) => `Исполнитель: ${label}`}
                />
                <Bar dataKey="taskCount" fill="var(--info-bright)" />
              </BarChart>
            </ResponsiveContainer>
            </div>
            <ChartDataTable caption="Нагрузка исполнителей: данные" columns={["Исполнитель", "Активных задач"]} rows={analytics.assigneeWorkload.slice(0, 8).map(item => [item.user?.name || "Пользователь недоступен", item.taskCount])} />
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}

// Type-only imports keep jspdf and its table plugin out of the analytics chunk.
// The libraries are fetched inside the export handler, when they are first used.
import type { jsPDF } from "jspdf";
import type { Table } from "jspdf-autotable";

type AutoTableDocument = jsPDF & { lastAutoTable: Pick<Table, "finalY"> };

interface ExportTask {
  title: string;
  status: string;
  priority: string;
  assignee?: string;
  deadline?: string;
  createdAt: string;
}

interface ExportAnalytics {
  tasksByStatus: Array<{ status: string; count: number }>;
  tasksByPriority: Array<{ priority: string; count: number }>;
  velocity: Array<{ week: string; completed: number; date: string }>;
  burndown: Array<{ date: string; remaining: number; ideal: number }>;
  summary: {
    totalTasks: number;
    completedThisMonth: number;
    overdueTasks: number;
  };
}

const statusLabels: Record<string, string> = {
  TODO: "К выполнению",
  IN_PROGRESS: "В работе",
  IN_REVIEW: "На проверке",
  DONE: "Готово",
};

const priorityLabels: Record<string, string> = {
  URGENT: "Срочно",
  HIGH: "Высокий",
  MEDIUM: "Средний",
  LOW: "Низкий",
};

export function exportTasksToCSV(tasks: ExportTask[], projectName?: string): void {
  const headers = ["Название", "Статус", "Приоритет", "Исполнитель", "Дедлайн", "Создано"];

  const rows = tasks.map(task => [
    task.title,
    statusLabels[task.status] || task.status,
    priorityLabels[task.priority] || task.priority,
    task.assignee || "-",
    task.deadline ? new Date(task.deadline).toLocaleDateString("ru-RU") : "-",
    new Date(task.createdAt).toLocaleDateString("ru-RU"),
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(",")),
  ].join("\n");

  const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", `${projectName || "tasks"}_${new Date().toISOString().split("T")[0]}.csv`);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function exportAnalyticsToPDF(analytics: ExportAnalytics, projectName?: string): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new jsPDF();

  // Title
  doc.setFontSize(20);
  doc.text(projectName ? `Аналитика: ${projectName}` : "Аналитика проектов", 14, 20);

  // Date
  doc.setFontSize(10);
  doc.text(`Дата: ${new Date().toLocaleDateString("ru-RU")}`, 14, 28);

  // Summary
  doc.setFontSize(14);
  doc.text("Сводка", 14, 40);
  doc.setFontSize(10);
  doc.text(`Всего задач: ${analytics.summary.totalTasks}`, 14, 48);
  doc.text(`Выполнено за месяц: ${analytics.summary.completedThisMonth}`, 14, 54);
  doc.text(`Просрочено: ${analytics.summary.overdueTasks}`, 14, 60);

  // Tasks by Status
  doc.setFontSize(14);
  doc.text("Задачи по статусам", 14, 75);

  autoTable(doc, {
    startY: 80,
    head: [["Статус", "Количество"]],
    body: analytics.tasksByStatus.map(item => [
      statusLabels[item.status] || item.status,
      item.count.toString(),
    ]),
    theme: "grid",
    headStyles: { fillColor: [59, 130, 246] },
  });

  // Tasks by Priority
  const finalY1 = (doc as AutoTableDocument).lastAutoTable.finalY || 120;
  doc.setFontSize(14);
  doc.text("Задачи по приоритетам", 14, finalY1 + 10);

  autoTable(doc, {
    startY: finalY1 + 15,
    head: [["Приоритет", "Количество"]],
    body: analytics.tasksByPriority.map(item => [
      priorityLabels[item.priority] || item.priority,
      item.count.toString(),
    ]),
    theme: "grid",
    headStyles: { fillColor: [139, 92, 246] },
  });

  // Velocity
  const finalY2 = (doc as AutoTableDocument).lastAutoTable.finalY || 160;

  if (finalY2 > 240) {
    doc.addPage();
    doc.setFontSize(14);
    doc.text("Velocity (последние 4 недели)", 14, 20);

    autoTable(doc, {
      startY: 25,
      head: [["Неделя", "Выполнено задач"]],
      body: analytics.velocity.map(item => [
        item.week,
        item.completed.toString(),
      ]),
      theme: "grid",
      headStyles: { fillColor: [16, 185, 129] },
    });
  } else {
    doc.setFontSize(14);
    doc.text("Velocity (последние 4 недели)", 14, finalY2 + 10);

    autoTable(doc, {
      startY: finalY2 + 15,
      head: [["Неделя", "Выполнено задач"]],
      body: analytics.velocity.map(item => [
        item.week,
        item.completed.toString(),
      ]),
      theme: "grid",
      headStyles: { fillColor: [16, 185, 129] },
    });
  }

  // Burndown (last 7 days for brevity)
  const finalY3 = (doc as AutoTableDocument).lastAutoTable.finalY || 200;

  if (finalY3 > 240) {
    doc.addPage();
    doc.setFontSize(14);
    doc.text("Burndown (последние 7 дней)", 14, 20);

    autoTable(doc, {
      startY: 25,
      head: [["Дата", "Осталось задач", "Идеальная"]],
      body: analytics.burndown.slice(-7).map(item => [
        new Date(item.date).toLocaleDateString("ru-RU"),
        item.remaining.toString(),
        item.ideal.toString(),
      ]),
      theme: "grid",
      headStyles: { fillColor: [239, 68, 68] },
    });
  } else {
    doc.setFontSize(14);
    doc.text("Burndown (последние 7 дней)", 14, finalY3 + 10);

    autoTable(doc, {
      startY: finalY3 + 15,
      head: [["Дата", "Осталось задач", "Идеальная"]],
      body: analytics.burndown.slice(-7).map(item => [
        new Date(item.date).toLocaleDateString("ru-RU"),
        item.remaining.toString(),
        item.ideal.toString(),
      ]),
      theme: "grid",
      headStyles: { fillColor: [239, 68, 68] },
    });
  }

  // Save
  doc.save(`${projectName || "analytics"}_${new Date().toISOString().split("T")[0]}.pdf`);
}

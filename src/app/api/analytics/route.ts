import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiInternalError
} from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    // Every aggregate below is scoped by the same server predicate as task
    // lists and cards. A client projectId only narrows it; counts never reveal
    // tasks the caller cannot read.
    const whereClause = await getTaskReadWhere(user, projectId ? { projectId } : {});

    // Get task counts by status
    const tasksByStatus = await prisma.task.groupBy({
      by: ['status'],
      where: whereClause,
      _count: {
        id: true,
      },
    });

    // Get task counts by priority
    const tasksByPriority = await prisma.task.groupBy({
      by: ['priority'],
      where: whereClause,
      _count: {
        id: true,
      },
    });

    // Get completion rate over last 4 weeks
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const completedTasks = await prisma.task.groupBy({
      by: ['status'],
      where: {
        ...whereClause,
        updatedAt: {
          gte: fourWeeksAgo,
        },
        status: 'DONE',
      },
      _count: {
        id: true,
      },
    });

    // Get velocity data (tasks completed per week for last 4 weeks)
    const velocityWeeks = [3, 2, 1, 0].map(i => {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (i * 7 + 7));
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() - (i * 7));
      return { i, weekStart, weekEnd };
    });
    const velocityCounts = await Promise.all(velocityWeeks.map(({ weekStart, weekEnd }) =>
      prisma.task.count({
        where: {
          ...whereClause,
          status: 'DONE',
          updatedAt: {
            gte: weekStart,
            lt: weekEnd,
          },
        },
      }),
    ));
    const velocityData = velocityWeeks.map(({ i, weekStart }, index) => ({
      week: `Week ${4 - i}`,
      completed: velocityCounts[index],
      date: weekStart.toISOString().split('T')[0],
    }));

    // Get assignee workload
    const assigneeWorkload = await prisma.taskAssignee.groupBy({
      by: ['userId'],
      where: {
        task: {
          ...whereClause,
          status: {
            not: 'DONE',
          },
        },
      },
      _count: {
        taskId: true,
      },
      orderBy: {
        _count: {
          taskId: 'desc',
        },
      },
      take: 10,
    });

    // Get user details for assignee workload
    const userIds = assigneeWorkload.map(a => a.userId);
    const users = await prisma.user.findMany({
      where: {
        id: {
          in: userIds,
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    const assigneeWorkloadWithUsers = assigneeWorkload.map(workload => {
      const user = users.find(u => u.id === workload.userId);
      return {
        userId: workload.userId,
        taskCount: workload._count.taskId,
        user: user ? {
          name: user.name || user.email,
          email: user.email,
        } : null,
      };
    });

    // Get overdue tasks count
    const now = new Date();
    const overdueTasks = await prisma.task.count({
      where: {
        ...whereClause,
        deadline: {
          lt: now,
        },
        status: {
          not: 'DONE',
        },
      },
    });

    // Derive the total from the status groups instead of a second full count.
    const totalTasks = tasksByStatus.reduce((sum, row) => sum + (row._count?.id ?? 0), 0);

    // Get burndown data (last 14 days)
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const burndownDays = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(i => {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      return { date, endOfDay };
    });

    // Count tasks that were NOT done at end of each day; the days are independent.
    const burndownCounts = await Promise.all(burndownDays.map(({ endOfDay }) =>
      prisma.task.count({
        where: {
          ...whereClause,
          createdAt: {
            lte: endOfDay,
          },
          OR: [
            { status: { not: 'DONE' } },
            {
              status: 'DONE',
              updatedAt: {
                gt: endOfDay,
              },
            },
          ],
        },
      }),
    ));

    const burndownData = burndownDays.map(({ date }, index) => ({
      date: date.toISOString().split('T')[0],
      remaining: burndownCounts[index],
    }));

    // Calculate ideal burndown line
    const startRemaining = burndownData[0]?.remaining || 0;
    const burndownWithIdeal = burndownData.map((item, index) => ({
      ...item,
      ideal: Math.max(0, Math.round(startRemaining - (startRemaining / 13) * index)),
    }));

    return apiSuccess({
      tasksByStatus: tasksByStatus.map(item => ({
        status: item.status,
        count: item._count.id,
      })),
      tasksByPriority: tasksByPriority.map(item => ({
        priority: item.priority,
        count: item._count.id,
      })),
      velocity: velocityData,
      assigneeWorkload: assigneeWorkloadWithUsers,
      burndown: burndownWithIdeal,
      summary: {
        totalTasks,
        completedThisMonth: completedTasks.reduce((sum, item) => sum + item._count.id, 0),
        overdueTasks,
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить аналитику");
  }
}
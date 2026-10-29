import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { requireProjectMemberAdmin, requireProjectRead } from "@/lib/project-access";
import { notifyProjectMemberAdded } from "@/lib/notification-triggers";
import { emitProjectMembersUpdated } from "@/socket/board-events";
import { decodeOrganizationApplicantPolicy } from "@/lib/organization-command";
import { evaluateProjectApplicantPolicy } from "@/lib/access-policy";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  role: z.enum(["MEMBER", "PROJECT_ADMIN"]).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(request);
    const params = await context.params;

    // Reading the roster is part of reading the project: the board's assignee
    // filter and the assignee picker load it for every participant. Managing the
    // roster (POST/PATCH/DELETE) stays behind requireProjectMemberAdmin.
    const access = await requireProjectRead(user, params.id);

    // Everyone who can read the project sees the same identities a task already
    // shows (assignee name, email, avatar). `globalRole` and `addedBy` are
    // management facts used only by the members dialog, so they stay with the
    // people allowed to open it.
    const rosterSelect = {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true, name: true, avatarUrl: true } },
    };

    const members = access.canManageMembers
      ? await prisma.projectMember.findMany({
        where: { projectId: params.id },
        orderBy: { createdAt: "asc" },
        select: {
          ...rosterSelect,
          user: { select: { id: true, email: true, name: true, avatarUrl: true, globalRole: true,
            primaryDepartment: { select: { id: true, name: true, archivedAt: true } } } },
          addedBy: { select: { id: true, email: true, name: true } },
        },
      })
      : await prisma.projectMember.findMany({
        where: { projectId: params.id },
        orderBy: { createdAt: "asc" },
        select: rosterSelect,
      });

    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        ownerId: true,
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            ...(access.canManageMembers ? { globalRole: true } : {}),
          },
        },
      },
    });

    const rosterUserIds = [...new Set([
      ...members.map(member => member.user.id),
      ...(project?.ownerId ? [project.ownerId] : []),
    ])];
    const groupContext = access.canManageMembers ? await prisma.project.findUnique({
      where: { id: params.id },
      select: { applicantPolicyConfig: { select: { policy: true } },
        department: { select: { id: true, name: true, leaderId: true, archivedAt: true } },
        responsibleGroup: { select: {
        id: true, name: true, leaderId: true, archivedAt: true,
        members: { where: { userId: { in: rosterUserIds } }, select: { userId: true } },
      } } },
    }) : null;
    const group = groupContext?.responsibleGroup;
    const department = groupContext?.department?.archivedAt === null ? groupContext.department : null;
    const activeGroup = group?.archivedAt === null ? group : null;
    const policyConfig = groupContext?.applicantPolicyConfig;
    // The saved-policy decoder/evaluator are shared with submission access.
    // This is a manager-only factual preview, never a new access grant.
    const policy = policyConfig == null ? null : decodeOrganizationApplicantPolicy(policyConfig.policy);
    if (policyConfig != null && policy === null) throw new Error("Invalid saved project applicant policy");
    const subjects = access.canManageMembers && policy !== null ? await prisma.user.findMany({
      where: { id: { in: rosterUserIds } },
      select: { id: true, primaryDepartment: { select: { id: true, archivedAt: true } } },
    }) : [];
    const policyMemberships = access.canManageMembers && policy !== null && policy.groupIds.length > 0
      ? await prisma.responsibleGroupMember.findMany({
        where: { userId: { in: rosterUserIds }, groupId: { in: policy.groupIds }, group: { archivedAt: null } },
        select: { userId: true, groupId: true },
      }) : [];
    const memberFunctions = rosterUserIds.map(userId => {
      const subject = subjects.find(person => person.id === userId);
      return {
        userId,
        leadership: [
          ...(department?.leaderId === userId ? [{ kind: "department", id: department.id, name: department.name }] : []),
          ...(activeGroup?.leaderId === userId ? [{ kind: "group", id: activeGroup.id, name: activeGroup.name }] : []),
        ],
        applicant: policy !== null && !subject ? { allowed: null, source: "unavailable" } : evaluateProjectApplicantPolicy(policy, {
          userId,
          activePrimaryDepartmentId: subject?.primaryDepartment?.archivedAt === null ? subject.primaryDepartment.id : null,
          activeGroupIds: policyMemberships.filter(member => member.userId === userId).map(member => member.groupId),
        }),
      };
    });

    return apiSuccess({
      projectId: params.id,
      ownerId: project?.ownerId ?? null,
      owner: project?.owner ?? null,
      items: members,
      ...(access.canManageMembers ? {
        memberFunctions,
        functionContext: {
          applicantPolicyConfigured: policy !== null,
          departmentLeadershipAssigned: department ? department.leaderId != null : null,
          groupLeadershipAssigned: activeGroup ? activeGroup.leaderId != null : null,
        },
        responsibleGroup: group && group.archivedAt === null ? {
          id: group.id,
          name: group.name,
          memberUserIds: group.members.map(member => member.userId),
        } : null,
      } : {}),
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    if (String(e).includes("NotFound")) return apiNotFound();
    return apiInternalError("Не удалось загрузить участников проекта");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = addSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const actor = await requireApiUser(request);
    const params = await context.params;

    await requireProjectMemberAdmin(actor, params.id);

    const target = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (!target) {
      // Don't disclose whether user exists in other contexts; here it's admin-only.
      return apiNotFound();
    }

    // Get project name for notification
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: { name: true },
    });

    // Check if this is a new member (not just role update)
    const existingMember = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: params.id, userId: target.id } },
    });
    const isNewMember = !existingMember;

    // Prevent adding owner as member redundantly is fine, but harmless.
    const created = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: params.id, userId: target.id } },
      update: {
        role: parsed.data.role ?? "MEMBER",
        addedById: actor.id,
      },
      create: {
        projectId: params.id,
        userId: target.id,
        role: parsed.data.role ?? "MEMBER",
        addedById: actor.id,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
    });

    // Send notification to newly added member
    if (isNewMember && project) {
      const adderName = actor.name || actor.email;
      notifyProjectMemberAdded({
        projectId: params.id,
        projectName: project.name,
        userId: target.id,
        addedById: actor.id,
        addedByName: adderName,
        role: parsed.data.role ?? "MEMBER",
      }).catch((err) => console.error("Failed to send notification:", err));
    }

    // Emit real-time update to all connected clients
    emitProjectMembersUpdated(params.id, created);

    return apiSuccess(created, undefined, 201);
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    if (String(e).includes("NotFound")) return apiNotFound();
    return apiInternalError("Не удалось добавить участника проекта");
  }
}

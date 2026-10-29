/** Explicit release action, never startup. Only audited commands may write. */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { createOrganizationService } from '../src/lib/organization';
import { ORGANIZATION_STATE_ID, decodeOrganizationApplicantPolicy } from '../src/lib/organization-command';

const NAME = 'Безнал ОП';
const ACTOR = 'admin-bootstrap';
const APPROVAL = '2026-10-28-approved';
const POLICY = { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] };
const METHODS = ['createDepartment', 'createGroup', 'createBoard', 'bindProject', 'setProjectApplicantPolicy'] as const;
type Method = typeof METHODS[number];

export function operationId(method: Method): string {
  const bytes = createHash('sha256').update('lenkanban:beznal-op:2026-10-28:v1:' + method).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function need(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

export async function provisionBeznalOp(
  database: PrismaClient,
  approval: string | undefined,
  organization = createOrganizationService(database),
) {
  need(approval === undefined || approval === APPROVAL, 'INVALID_PROVISION_APPROVAL');
  const apply = approval === APPROVAL;
  async function requireActiveAdmin() {
    const admin = await database.user.findUnique({ where: { id: ACTOR }, select: { globalRole: true, isBlocked: true, blockedAt: true } });
    need(admin?.globalRole === 'ADMIN' && admin.isBlocked === false && admin.blockedAt === null, 'ACTIVE_EXISTING_ADMIN_REQUIRED');
  }
  await requireActiveAdmin();

  async function inventory() {
    const [departments, groups, boards, receipts] = await Promise.all([
      database.department.findMany({ where: { name: NAME }, select: { id: true, parentId: true, leaderId: true, archivedAt: true,
        _count: { select: { employees: true, children: true } } } }),
      database.responsibleGroup.findMany({ where: { name: NAME }, select: { id: true, leaderId: true, archivedAt: true,
        _count: { select: { members: true } } } }),
      database.project.findMany({ where: { name: NAME }, select: { id: true, ownerId: true, departmentId: true, responsibleGroupId: true,
        applicantPolicyConfig: { select: { policy: true } }, columns: { select: { id: true, workflowKey: true } },
        lifecycleColumnMap: true, _count: { select: { members: true } } } }),
      database.organizationOperation.findMany({ where: { actorId: ACTOR, operationId: { in: METHODS.map(operationId) } },
        select: { operationId: true, operation: true, targetId: true, expectedVersion: true } }),
    ]);
    need(departments.length <= 1 && groups.length <= 1 && boards.length <= 1, 'DUPLICATE_BEZNAL_NAMES');
    const saved = new Map(receipts.map(receipt => [receipt.operationId, receipt]));
    const owned = (method: Method, row: { id: string } | undefined) => {
      const receipt = saved.get(operationId(method));
      need(row ? receipt?.operation === method && receipt.targetId === row.id : receipt === undefined, 'UNOWNED_OR_MISSING_BEZNAL_RESOURCE');
    };
    const department = departments[0], group = groups[0], board = boards[0];
    owned('createDepartment', department); owned('createGroup', group); owned('createBoard', board);
    need(!group || department, 'INVALID_PROVISION_SEQUENCE');
    need(!board || department && group, 'INVALID_PROVISION_SEQUENCE');
    for (const method of ['bindProject', 'setProjectApplicantPolicy'] as const) {
      const receipt = saved.get(operationId(method));
      need(!receipt || board && receipt.operation === method && receipt.targetId === board.id, 'INVALID_PROVISION_RECEIPT');
    }
    need(!saved.has(operationId('setProjectApplicantPolicy')) || saved.has(operationId('bindProject')), 'INVALID_PROVISION_SEQUENCE');
    if (department) need(department.archivedAt === null && department.parentId === null && department.leaderId === null
      && department._count.employees === 0 && department._count.children === 0, 'DEPARTMENT_CONFIGURATION_CHANGED');
    if (group) need(group.archivedAt === null && group.leaderId === null && group._count.members === 0, 'GROUP_CONFIGURATION_CHANGED');
    if (board) {
      need(board.ownerId === ACTOR && board._count.members === 0 && board.responsibleGroupId === group.id,
        'BOARD_CONFIGURATION_CHANGED');
      need(board.departmentId === (saved.has(operationId('bindProject')) ? null : department.id), 'BOARD_BINDING_CHANGED');
      const policy = saved.has(operationId('setProjectApplicantPolicy'));
      need(policy ? JSON.stringify(decodeOrganizationApplicantPolicy(board.applicantPolicyConfig?.policy)) === JSON.stringify(POLICY)
        : board.applicantPolicyConfig === null, 'BOARD_APPLICANT_POLICY_CHANGED');
      const keys = new Map(board.columns.map(column => [column.workflowKey, column.id]));
      const map = board.lifecycleColumnMap as Record<string, unknown> | null;
      need(keys.size === 5 && board.columns.length === 5 && ['TODO', 'IN_PROGRESS', 'NEEDS_INFO', 'REVIEW', 'DONE'].every(key => keys.has(key))
        && map?.contractVersion === 1 && map.submittedColumnId === keys.get('TODO') && map.inProgressColumnId === keys.get('IN_PROGRESS')
        && map.needsInfoColumnId === keys.get('NEEDS_INFO') && map.completedColumnId === keys.get('REVIEW') && map.closedColumnId === keys.get('DONE'),
      'CANONICAL_LIFECYCLE_REQUIRED');
    }
    if (department || group) {
      const linked = await database.project.findMany({ where: { OR: [
        ...(department ? [{ departmentId: department.id }] : []), ...(group ? [{ responsibleGroupId: group.id }] : []),
      ] }, select: { id: true } });
      need(linked.every(row => row.id === board?.id), 'OWNED_TEAM_USED_BY_OTHER_BOARD');
    }
    return { department, group, board, saved };
  }

  let state = await inventory();
  if (apply) {
    async function command(method: Method, payload: Record<string, unknown>) {
      await requireActiveAdmin();
      // expectedVersion participates in requestHash: replay the saved version.
      const receipt = state.saved.get(operationId(method));
      const expectedVersion = receipt?.expectedVersion ?? (await database.organizationState.findUnique({
        where: { id: ORGANIZATION_STATE_ID }, select: { version: true },
      }))?.version ?? 0;
      const actor = { actorId: ACTOR, operationId: operationId(method), expectedVersion };
      const dispatch = organization[method] as (input: typeof actor & Record<string, unknown>) => Promise<unknown>;
      await dispatch({ ...actor, ...payload });
      state = await inventory();
    }
    await command('createDepartment', { name: NAME, parentId: null });
    await command('createGroup', { name: NAME });
    await command('createBoard', { name: NAME, departmentId: state.department!.id, responsibleGroupId: state.group!.id });
    await command('bindProject', { projectId: state.board!.id, departmentId: null, responsibleGroupId: state.group!.id });
    await command('setProjectApplicantPolicy', { projectId: state.board!.id, policy: POLICY });
  }
  await requireActiveAdmin();
  return { event: 'release.beznal_op.provision', mode: apply ? 'applied' : 'dry-run',
    departmentId: state.department?.id ?? null, responsibleGroupId: state.group?.id ?? null, projectId: state.board?.id ?? null,
    groupMembers: state.group?._count.members ?? 0, applicantPolicy: state.saved.has(operationId('setProjectApplicantPolicy')) ? POLICY : null,
    operationsRecorded: state.saved.size, complete: state.saved.size === METHODS.length,
    accountChanges: 0, existingBoardChanges: 0 };
}

if (require.main === module) {
  provisionBeznalOp(prisma, process.env.LENKANBAN_PROVISION_BEZNAL_OP)
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('BEZNAL_PROVISION_FAILED_REVIEW_PRIVATE_STATE'); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

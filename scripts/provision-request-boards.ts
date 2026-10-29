/** Explicit one-time release configuration. Never called during application startup.
 * Uses audited organization commands; no task backfill, migration or user changes.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { createOrganizationService } from '../src/lib/organization';
import { ORGANIZATION_STATE_ID } from '../src/lib/organization-command';
import { DEFAULT_BOARD_COLUMNS } from '../src/lib/request-board-columns';

async function main() {
  if (process.env.LENKANBAN_PROVISION_REQUEST_BOARDS !== '2026-10-25-redesign') throw new Error('Explicit provisioning switch required');
  const actorId = 'admin-bootstrap';
  const admin = await prisma.user.findUnique({where:{id:actorId},select:{globalRole:true,isBlocked:true}});
  if (!admin || admin.isBlocked || admin.globalRole !== 'ADMIN') throw new Error('Active administrator required');
  const organization = createOrganizationService(prisma);
  const actor = async () => ({actorId,operationId:randomUUID(),expectedVersion:(await prisma.organizationState.findUnique({where:{id:ORGANIZATION_STATE_ID},select:{version:true}}))?.version??0});
  const support = await prisma.project.findUniqueOrThrow({where:{id:'cmvkyg7hn0001o001mfarh0fb'},include:{columns:{orderBy:{position:'asc'}},members:{select:{userId:true}}}});
  if (support.columns.length !== 5) throw new Error('Review existing support columns first');
  // Preserve every ID, workflow key, task and membership. Only labels change.
  await prisma.$transaction(async tx => {
    await tx.project.update({where:{id:support.id},data:{name:'🛠 Техподдержка и ИТ'}});
    for (const [index,column] of support.columns.entries()) await tx.projectColumn.update({where:{id:column.id},data:{name:DEFAULT_BOARD_COLUMNS[index].name}});
  });
  const map={contractVersion:1 as const,submittedColumnId:support.columns[0].id,inProgressColumnId:support.columns[1].id,needsInfoColumnId:support.columns[2].id,completedColumnId:support.columns[3].id,closedColumnId:support.columns[4].id};
  await organization.setProjectLifecycleColumns({...await actor(),projectId:support.id,lifecycleColumnMap:map});
  let claims = await prisma.project.findFirst({where:{name:'🔥 Претензии клиентов'},select:{id:true}});
  if (!claims) {
    // No suitable quality department/group exists in the production inventory.
    // Create an empty team; never assign unrelated IT employees to complaints.
    let department=await prisma.department.findFirst({where:{name:'Отдел качества',archivedAt:null},select:{id:true}});
    if(!department) department=(await organization.createDepartment({...await actor(),name:'Отдел качества',parentId:null})).result;
    let group=await prisma.responsibleGroup.findFirst({where:{name:'Претензии клиентов',archivedAt:null},select:{id:true}});
    if(!group) group=(await organization.createGroup({...await actor(),name:'Претензии клиентов'})).result;
    claims=(await organization.createBoard({...await actor(),name:'🔥 Претензии клиентов',departmentId:department.id,responsibleGroupId:group.id})).result;
  }
  // Reconcile each step after a partial run, including a committed board whose
  // membership/policy setup was interrupted. Never overwrite an existing policy.
  await prisma.projectMember.createMany({data:support.members.map(member=>({projectId:claims!.id,userId:member.userId,role:'MEMBER' as const})),skipDuplicates:true});
  const configured=await prisma.projectApplicantPolicy.findUnique({where:{projectId:claims.id},select:{policy:true}});
  if(!configured) await organization.setProjectApplicantPolicy({...await actor(),projectId:claims.id,policy:{allEmployees:false,userIds:support.members.map(member=>member.userId),departmentIds:[],groupIds:[]}});
  const actualMembers=await prisma.projectMember.findMany({where:{projectId:claims.id},select:{userId:true}});
  if(support.members.some(member=>!actualMembers.some(actual=>actual.userId===member.userId))) throw new Error('Claims membership reconciliation incomplete');
  const boards=await prisma.project.findMany({where:{id:{in:[support.id,claims.id]}},select:{id:true,name:true,lifecycleColumnMap:true,responsibleGroup:{select:{_count:{select:{members:true}}}},_count:{select:{members:true,tasks:true}}}});
  console.log(JSON.stringify({event:'release.request_boards.configured',boards}));
}
main().catch(()=>{console.error('Request board provisioning failed; inspect private release diagnostics.');process.exitCode=1;}).finally(()=>prisma.$disconnect());
